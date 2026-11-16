// Credential delivery for password fill. The value enters through one of
// three channels (stdin, a validated one-shot handoff file, or a
// JEV_PASSWORD_* environment variable), lives in memory for a single run,
// and is redacted from every model-facing and serialized output. It must
// never appear in argv, tool arguments, the task, model context, traces,
// screenshots, or error messages.
import { domainToUnicode } from "node:url";
import { chmod, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

/** Naming a variable with this prefix is the operator's opt-in for password_env. */
export const PASSWORD_ENV_PREFIX = "JEV_PASSWORD_";
/** Naming a variable with this prefix is the operator's opt-in for cookie_env. */
export const COOKIE_ENV_PREFIX = "JEV_COOKIE_";
export const MAX_SECRET_BYTES = 4096;
export const MIN_SECRET_CHARS = 4;
export const PASSWORD_REDACTED = "[REDACTED]";
/**
 * Exact-origin check for the password trust anchor: scheme://host[:port]
 * with no path, query, credentials, or wildcard. HTTPS is required except on
 * loopback hosts. Returns the canonical origin string, or null.
 */
export function parseTrustedOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.search || url.hash) return null;
  if (url.username || url.password) return null;
  // A wildcard (literal or percent-encoded) is not an exact origin. The
  // in-page equality check would refuse it anyway; rejecting it here keeps a
  // misconfigured trust anchor from consuming the one-shot handoff file and
  // launching a doomed run.
  if (/[*%]/.test(url.hostname)) return null;
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  return url.origin;
}

/** The handoff directory for password files. Override for tests and containers. */
export function handoffDir(): string {
  return process.env.JEV_BROWSER_HANDOFF_DIR || resolve(homedir(), ".jev-browser", "handoff");
}

export const WIN32_HANDOFF_UNSUPPORTED =
  "password handoff via secret file is unsupported on Windows; POSIX ownership/mode checks cannot be enforced";

/** Fail closed: POSIX uid/mode semantics do not exist on win32, so never trust them there. */
function assertHandoffSupported(): number {
  if (process.platform === "win32" || typeof process.getuid !== "function") throw new Error(WIN32_HANDOFF_UNSUPPORTED);
  return process.getuid();
}

/** The handoff directory must be a private directory owned by this user. */
export async function ensureHandoffDir(dir = handoffDir()): Promise<void> {
  const uid = assertHandoffSupported();
  const resolved = resolve(dir);
  const st = await lstat(resolved).catch(() => null);
  if (st) {
    if (!st.isDirectory()) throw new Error(`handoff directory ${resolved} is not a directory`);
    if (st.uid !== uid) throw new Error(`handoff directory ${resolved} is not owned by this user`);
    if ((st.mode & 0o777) !== 0o700) {
      throw new Error(`handoff directory ${resolved} must be mode 0700; run chmod 700 on it or point JEV_BROWSER_HANDOFF_DIR elsewhere`);
    }
  } else {
    await mkdir(resolved, { recursive: true, mode: 0o700 });
    await chmod(resolved, 0o700);
  }
  // Revalidate what actually landed. mkdir mode is umask-masked, parents may
  // have been created by a looser rule, and a symlink anywhere in the chain
  // (the dir itself or a parent, pre-existing or fresh) would let a
  // basename-only file rule escape the intended location: the resolved real
  // path must equal the lexical one. lstat above only guards the final
  // component, so realpath is what closes intermediate symlinks.
  const real = await realpath(resolved).catch(() => null);
  const after = await lstat(resolved).catch(() => null);
  if (
    real === null ||
    real !== resolved ||
    !after?.isDirectory() ||
    after.uid !== uid ||
    (after.mode & 0o777) !== 0o700
  ) {
    throw new Error(`handoff directory ${resolved} must be a symlink-free 0700 directory owned by this user`);
  }
}

/**
 * Validates decoded secret bytes. Exact bytes are preserved: never trimmed,
 * because surrounding whitespace can be part of a password. Producers should
 * use a no-newline mode (e.g. `op read --no-newline`).
 */
export function validateSecretBuffer(buf: Buffer, label = "password"): string {
  if (buf.length === 0) throw new Error(`${label} is empty`);
  if (buf.length > MAX_SECRET_BYTES) throw new Error(`${label} exceeds ${MAX_SECRET_BYTES} bytes`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new Error(`${label} is not valid UTF-8 text`);
  }
  if (text.includes("\u0000")) throw new Error(`${label} contains a NUL byte`);
  // Native password inputs run the value sanitization algorithm: CR and LF
  // are stripped on assignment. A secret containing them could never be
  // filled faithfully, and a page echoing the stripped value back would
  // produce a string no redaction variant matches. Reject up front.
  if (/[\r\n]/.test(text)) throw new Error(`${label} contains a line break; password inputs strip CR/LF, so it could never be filled (produce it without the trailing newline, e.g. op read --no-newline)`);
  // Control characters (C0, DEL, and C1) are JSON/YAML-escaped differently
  // by every serializer that touches an echo (aria snapshots, markdown,
  // console capture). Rather than chase each escape form, refuse them: no
  // real password contains them.
  if (/[\x00-\x1f\x7f-\x9f]/.test(text)) throw new Error(`${label} contains a control character`);
  // Code points, not UTF-16 units: two emoji must not count as four characters.
  if ([...text].length < MIN_SECRET_CHARS) throw new Error(`${label} is shorter than ${MIN_SECRET_CHARS} characters`);
  // Pages normalize whitespace when echoing (collapsed DOM text, trimmed
  // labels), and accessible-name resolution additionally strips zero-width
  // characters. The normalized echo must stay a redactable variant: if it
  // collapses below the safe redaction length, no variant could match it
  // without matching ordinary words everywhere.
  const normalized = normalizeEcho(text);
  if ([...normalized].length < MIN_SECRET_CHARS) {
    throw new Error(`${label} collapses below ${MIN_SECRET_CHARS} characters when whitespace is normalized (pages echo it that way); choose a longer one`);
  }
  return text;
}

/** Reads a secret from stdin. Rejects interactive terminals and oversize input. */
export async function readSecretFromStdin(): Promise<Buffer> {
  if (process.stdin.isTTY) {
    throw new Error(
      "refusing to read a password from an interactive terminal; pipe it instead, e.g. op read --no-newline 'op://...' | jev-browser run ... --password-file -",
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_SECRET_BYTES) throw new Error(`password on stdin exceeds ${MAX_SECRET_BYTES} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Consumes a one-shot handoff file. The path must be a plain absolute path
 * naming a direct child of the handoff directory: no subdirectories, no "..",
 * no traversal. The file is opened with O_NOFOLLOW (symlinks fail), validated
 * as a private regular file owned by this user with exactly mode 0600 and a
 * single link, its identity re-checked against the pathname, unlinked, and
 * only then read through the already-open descriptor. Once opened, the file
 * is always unlinked, even when a later check fails: it is one-shot, and a
 * rejected secret must not be left on disk. The `what` label names the option
 * in error messages (password_file or cookie_file); the file contents are
 * never quoted.
 */
export async function readHandoffSecret(path: string, dir = handoffDir(), what = "password_file"): Promise<Buffer> {
  if (!isAbsolute(path)) throw new Error(`${what} must be an absolute path inside the handoff directory`);
  const resolvedPath = resolve(path);
  const resolvedDir = resolve(dir);
  const rel = relative(resolvedDir, resolvedPath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.includes("/") || rel.includes("\\")) {
    throw new Error(`${what} must be a file directly inside the handoff directory ${resolvedDir}, not a nested path`);
  }
  const uid = assertHandoffSupported();
  await ensureHandoffDir(resolvedDir);
  const fh = await open(resolvedPath, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  let unlinked = false;
  try {
    const st = await fh.stat(); // fstat on the pinned descriptor
    if (!st.isFile()) throw new Error(`${what} is not a regular file`);
    if (st.uid !== uid) throw new Error(`${what} is not owned by this user`);
    if ((st.mode & 0o777) !== 0o600) throw new Error(`${what} must be mode 0600; run chmod 600 on it and retry`);
    if (st.nlink !== 1) throw new Error(`${what} has multiple hard links`);
    if (st.size === 0) throw new Error(`${what} is empty`);
    if (st.size > MAX_SECRET_BYTES) throw new Error(`${what} exceeds ${MAX_SECRET_BYTES} bytes`);
    // The pathname must still name this exact inode: a replacement between
    // open and unlink would delete a different file than the one validated.
    const named = await lstat(resolvedPath).catch(() => null);
    if (!named || named.ino !== st.ino || named.dev !== st.dev) {
      throw new Error(`${what} was replaced while opening; retry with a fresh file`);
    }
    await unlink(resolvedPath);
    unlinked = true;
    const post = await fh.stat();
    if (post.nlink !== 0) throw new Error(`${what} still has links after being consumed; refusing to trust it`);
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const { bytesRead } = await fh.read(buf, read, st.size - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buf.subarray(0, read);
  } catch (error) {
    // One-shot even on failure, but only when the pathname still names the
    // inode we pinned: a replacement between open and unlink must not make
    // us delete the replacement, which is somebody else's file. The
    // lstat-to-unlink gap is not atomic; closing it fully needs an atomic
    // compare-inode-and-unlink that Node does not expose. The residual race
    // requires a same-UID process to win a microsecond window, and a
    // same-UID attacker already has strictly better attacks (ptrace, /proc
    // memory, replacing the binary), so this boundary is accepted.
    const cur = await lstat(resolvedPath).catch(() => null);
    const pinned = await fh.stat().catch(() => null);
    if (cur && pinned && cur.ino === pinned.ino && cur.dev === pinned.dev && !unlinked) {
      await unlink(resolvedPath).catch(() => {});
    }
    throw error;
  } finally {
    await fh.close().catch(() => {});
  }
}

const ENV_NAME_RE = /^[A-Z0-9_]+$/;

/**
 * Resolves a password_env request. Only JEV_PASSWORD_* names are considered;
 * every other name is rejected before its value is ever looked up, so the
 * model cannot probe arbitrary environment variables through this path.
 * The prefix and the option name in errors generalize to JEV_COOKIE_* for
 * seed-cookie delivery, with identical posture.
 */
export function readSecretFromEnv(name: string, opts: { prefix?: string; what?: string } = {}): Buffer {
  const prefix = opts.prefix ?? PASSWORD_ENV_PREFIX;
  const what = opts.what ?? "password_env";
  if (!name.startsWith(prefix) || !ENV_NAME_RE.test(name)) {
    throw new Error(`${what} must name a ${prefix}* variable; giving a variable that name is the opt-in`);
  }
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is not set in this server's environment`);
  if (value.length === 0) throw new Error(`${name} is empty`);
  return Buffer.from(value, "utf8");
}

/**
 * Playwright debug modes can record raw fill() values outside this package's
 * redaction boundary: PWDEBUG, the `debug` library namespaces Playwright logs
 * through (pw:api, pw:channel, pw:protocol, and wildcard specs like `*` that
 * include them), and DEBUG_FILE which redirects those logs to disk. Wildcard
 * semantics make an exact deny-list unreliable, so credential runs refuse any
 * nonempty PWDEBUG, DEBUG, and DEBUG_FILE outright.
 */
export function assertNoPlaywrightDebug(): void {
  const pwdebug = process.env.PWDEBUG;
  // "0" is refused too: unset it rather than zeroing it, so the rule stays
  // "any nonempty value" with no version-dependent exceptions.
  if (pwdebug !== undefined && pwdebug !== "") {
    throw new Error("PWDEBUG is set; unset it for password runs (Playwright debug output can include filled values)");
  }
  const debug = process.env.DEBUG ?? "";
  if (debug !== "") {
    throw new Error("DEBUG is set (including wildcards like * or pw:*); unset it for password runs (Playwright logs can include filled values)");
  }
  const debugFile = process.env.DEBUG_FILE ?? "";
  if (debugFile !== "") {
    throw new Error("DEBUG_FILE is set; unset it for password runs (debug logs are written there unredacted)");
  }
}

export interface Redactor {
  redact(s: string): string;
  redactDeep(value: unknown): any;
  /**
   * Redacts a string that was captured longer than it may be displayed and
   * returns at most `visible` characters. Position-preserving: an echo the
   * capture boundary cut mid-secret can never be pulled into the displayed
   * slice by earlier echoes shrinking to markers.
   */
  redactCapped(s: string, visible: number): string;
  /**
   * Length of the longest known representation of the secret. Capture
   * windows on credential runs are sized from this (visible limit + this
   * value), so an echo that starts inside the visible window is always
   * captured whole and can be redacted before any display slice.
   */
  maxVariantLength: number;
}

/**
 * The transformations page-side pipelines apply to an echoed string before
 * the redactor sees it: whitespace runs collapse and trim, zero-width
 * characters are stripped from accessible names. Used both to generate
 * redaction variants and to reject secrets whose echo would collapse below
 * the safe redaction length.
 */
function normalizeEcho(s: string): string {
  return s.replace(/[\u200b\u00ad]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Every form the WHATWG URL parser can produce from `secret` when it is placed in a URL component.
 * Derived by round-tripping through `new URL()` with ASCII sentinels (which no encode set touches)
 * around the secret, so the result tracks the platform's encode sets instead of a hand-kept list.
 * Not covered: mixed-case percent-hex within a single string, double encoding, and non-URL encodings.
 */
export function urlComponentForms(secret: string): string[] {
  const out = new Set<string>();
  const L = "zqjxa", R = "zqjxb";
  const between = (s: string): void => {
    const i = s.indexOf(L), j = s.lastIndexOf(R);
    if (i >= 0 && j > i) out.add(s.slice(i + L.length, j));
  };
  const attempts: Array<() => void> = [
    () => { const u = new URL("https://example.com/"); u.username = L + secret + R; between(u.username); },
    () => { const u = new URL("https://example.com/"); u.password = L + secret + R; between(u.password); },
    () => { const u = new URL("https://example.com/"); u.pathname = "/" + L + secret + R; between(u.pathname); },
    () => { const u = new URL("https://example.com/"); u.search = "?" + L + secret + R; between(u.search); },
    () => { const u = new URL("https://example.com/"); u.hash = "#" + L + secret + R; between(u.hash); },
    () => { const u = new URL("custom://example.com/"); u.search = "?" + L + secret + R; between(u.search); },
    () => { between(new URL("data:" + L + secret + R).pathname); },
    () => { between(new URL("https://example.com/?q=" + L + secret + R).search); },
    () => { between(new URL("https://example.com/#" + L + secret + R).hash); },
    () => { between(new URL("https://example.com/" + L + secret + R).pathname); },
    () => { between(new URL("https://" + L + secret + R + "@example.com/").username); },
    () => {
      // Host: the secret is the whole label sequence (IDNA mapping, lowercasing, punycode).
      // Only when the whole secret parsed as the entire host: a secret like `abc@google.com` or
      // `a/b.example` has a host that is not the secret, and an IPv4/IPv6 literal (`2130706433` ->
      // `127.0.0.1`) is a common string that must not be redacted everywhere.
      if (/[@/\\?#:[\]]/.test(secret)) return;
      const h = new URL("http://" + secret + "/");
      if (h.username || h.password || h.port || h.search || h.hash || h.pathname !== "/") return;
      if (h.hostname.startsWith("[") || /^[0-9.]+$/.test(h.hostname)) return;
      out.add(h.hostname);
      out.add(domainToUnicode(h.hostname));
    },
  ];
  for (const attempt of attempts) {
    try { attempt(); } catch { /* the parser rejects this placement; the other components still apply */ }
  }
  out.delete("");
  return Array.from(out);
}

/**
 * Per-run redactor covering the representations a page can echo back: the
 * raw value(s), their percent-encoded forms (URLs), and their HTML-entity
 * forms. Accepts one secret (the password value) or several (the password
 * plus every seed-cookie value): every representation of every secret is a
 * variant, variants are applied longest-first, and the marker postcondition
 * holds for all of them, so a shorter value that is a prefix of a longer
 * one can never survive inside the longer one's match. Applied to every
 * model-facing state, trace, error, and result payload.
 */
export function makeRedactor(secrets: string | string[]): Redactor {
  const secretList = Array.isArray(secrets) ? secrets : [secrets];
  const variants = new Set<string>();
  for (const secret of secretList) {
    variants.add(secret);
    // Percent encodings: encodeURIComponent (both hex cases) and the stricter
    // application/x-www-form-urlencoded serialization (space becomes +, more
    // punctuation is escaped), which is what URLSearchParams and form submits
    // produce.
    const pct = encodeURIComponent(secret);
    variants.add(pct);
    variants.add(pct.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
    variants.add(new URLSearchParams({ x: secret }).toString().slice(2));
    // Servers and proxies sometimes lowercase the percent hex; match that form.
    variants.add(new URLSearchParams({ x: secret }).toString().slice(2).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
    // Browser-normalised URL forms. Rather than hand-picking encodings, put the secret into each
    // component of a URL, let the WHATWG parser serialise it (userinfo, path, query for special and
    // non-special schemes, fragment, opaque path, host with lowercasing/IDNA/punycode), and take back
    // what the parser produced between sentinels. Percent-hex is emitted in both cases because
    // proxies and servers re-case it.
    for (const form of urlComponentForms(secret)) {
      variants.add(form);
      variants.add(form.replace(/%[0-9A-Fa-f]{2}/g, (m) => m.toUpperCase()));
      variants.add(form.replace(/%[0-9A-Fa-f]{2}/g, (m) => m.toLowerCase()));
    }
    // HTML entity encodings: the full named-attribute form, the partial
    // serializations real DOM APIs produce (textContent escapes only & and <;
    // attribute serialization escapes & < > " '), and numeric references.
    const named: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    const esc = (chars: string) => secret.replace(new RegExp(`[${chars.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}]`, "g"), (c) => named[c]);
    variants.add(esc("&"));
    variants.add(esc("&<"));
    variants.add(esc('&<>"\''));
    variants.add(Array.from(secret, (c) => `&#${c.codePointAt(0)!};`).join(""));
    variants.add(Array.from(secret, (c) => `&#x${c.codePointAt(0)!.toString(16)};`).join(""));
    // Markdown: Turndown escapes its special characters with a backslash, so
    // a secret containing one comes back as `ab\*cd` in markdown output.
    variants.add(secret.replace(/([\\`*_[\]])/g, "\\$1"));
    // ARIA snapshots serialize accessible names into quoted YAML strings:
    // the renderer JSON-stringifies the name (escaping quotes and
    // backslashes) and then YAML-quotes the assembled value (doubling
    // single quotes). Playwright composes both, so the composed form is a
    // variant; the individual forms cover other serializers.
    const ariaName = secret.replace(/(["\\])/g, "\\$1");
    variants.add(ariaName);
    variants.add(ariaName.replace(/'/g, "''"));
    variants.add(secret.replace(/'/g, "''"));
  }
  // Page-side pipelines normalize before we see the string: label resolution
  // collapses runs and trims, excerpts collapse, option labels trim, and
  // accessible-name computation strips zero-width characters. The normalized
  // echo of every variant is itself a variant.
  for (const v of Array.from(variants)) {
    variants.add(normalizeEcho(v));
  }
  const ordered = Array.from(variants)
    .filter((v) => v.length >= MIN_SECRET_CHARS)
    .sort((a, b) => b.length - a.length);
  // The output must never let the secret reassemble. A precomputed marker
  // check is not enough: a secret built from marker characters ("ED][RE",
  // "ED]next") can reappear when two inserted markers sit adjacent
  // ("[REDACTED][REDACTED]") or when a marker sits next to page text that
  // continues the secret. So every redact call enforces the postcondition
  // that no variant survives in its output. When the standard marker fails
  // it, the call re-runs from the original string with a single-character
  // marker whose character appears in no variant: no occurrence can then
  // include or span an inserted marker, which makes reassembly impossible.
  // Normal secrets keep the readable "[REDACTED]" marker.
  const variantChars = new Set<string>();
  for (const v of ordered) for (const ch of v) variantChars.add(ch);
  // A single character that appears in no variant: insertions of it can
  // never take part in a variant occurrence, so no occurrence can include
  // or span one. Selection is provably total under the enforced
  // MAX_SECRET_BYTES bound: every candidate character (U+2588 and all of
  // U+E000 through U+F8FF) encodes as exactly three UTF-8 bytes, and the
  // escape transforms synthesize only ASCII, so a candidate can only reach
  // a variant from the secret itself. A 4,096-byte secret therefore covers
  // at most floor(4096/3) = 1,365 candidates — far short of the 6,400-
  // character private-use scan plus the five short candidates.
  const pickAbsent = (): string => {
    for (const c of ["\u2588", "\uE000", "\uE001", "\uE002", "\uE003"]) {
      if (!variantChars.has(c)) return c;
    }
    for (let cp = 0xe000; cp <= 0xf8ff; cp++) {
      const c = String.fromCharCode(cp);
      if (!variantChars.has(c)) return c;
    }
    throw new Error("unreachable: no character is absent from a finite set");
  };
  const blocker = pickAbsent();
  // Encoding-independent matching. Each secret is matched as UTF-8 bytes against the text decoded
  // into bytes: a literal character contributes its UTF-8 bytes, a well-formed %XX escape (either hex
  // case) contributes one byte. So any mix of literal and percent-escaped characters that decodes to
  // the secret is one span, whatever the browser chose to escape. The decoded stream is built in one
  // pass with the text offset of each byte, then every pattern is matched with KMP: linear time, no
  // regex built from the secret, nothing that can backtrack. Secrets with lone surrogates are not
  // byte-representable and keep only the variant matching.
  const wellFormed = (s: string): boolean => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const d = s.charCodeAt(i + 1);
        if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
        i++;
      } else if (c >= 0xdc00 && c <= 0xdfff) return false;
    }
    return true;
  };
  const patternSeen = new Set<string>();
  const patterns: Uint8Array[] = [];
  for (const secret of secretList) {
    for (const form of [secret, normalizeEcho(secret)]) {
      if ([...form].length < MIN_SECRET_CHARS || !wellFormed(form) || patternSeen.has(form)) continue;
      patternSeen.add(form);
      patterns.push(Uint8Array.from(Buffer.from(form, "utf8")));
    }
  }
  const patternFailures = patterns.map((v) => {
    const f = new Int32Array(v.length);
    let k = 0;
    for (let i = 1; i < v.length; i++) {
      while (k > 0 && v[i] !== v[k]) k = f[k - 1];
      if (v[i] === v[k]) k++;
      f[i] = k;
    }
    return f;
  });
  // All patterns in one Aho-Corasick automaton (dense byte transitions, one table lookup per stream
  // byte) so the cost does not scale with the number of secrets. Built only while the table stays
  // small (<= 16 MB); beyond that the patterns are matched one KMP pass each.
  let acNext: Int32Array | null = null;
  let acLen: Int32Array = new Int32Array(0); // longest pattern ending at each state
  {
    let total = 1;
    for (const v of patterns) total += v.length;
    if (patterns.length > 0 && total * 256 <= 4_194_304) {
      const next = new Int32Array(total * 256).fill(-1);
      const len = new Int32Array(total);
      let states = 1;
      for (const v of patterns) {
        let st = 0;
        for (const b of v) {
          if (next[st * 256 + b] < 0) next[st * 256 + b] = states++;
          st = next[st * 256 + b];
        }
        len[st] = Math.max(len[st], v.length);
      }
      const fail = new Int32Array(states);
      const queue: number[] = [];
      for (let c = 0; c < 256; c++) {
        const s1 = next[c];
        if (s1 < 0) next[c] = 0;
        else queue.push(s1);
      }
      for (let qi = 0; qi < queue.length; qi++) {
        const st = queue[qi];
        len[st] = Math.max(len[st], len[fail[st]]);
        for (let c = 0; c < 256; c++) {
          const s1 = next[st * 256 + c];
          if (s1 < 0) next[st * 256 + c] = next[fail[st] * 256 + c];
          else {
            fail[s1] = next[fail[st] * 256 + c];
            queue.push(s1);
          }
        }
      }
      acNext = next;
      acLen = len;
    }
  }
  const hexVal = (c: number): number =>
    c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1;
  // Streaming matcher state. Memory is O(longest pattern), independent of input length: a ring of
  // the text offsets (and "first byte of its text unit" flags) of the last maxPatternLen decoded
  // bytes. Whether a byte is the last of its unit, and where that unit ends, is known at emit time.
  let maxPatternLen = 1;
  for (const v of patterns) if (v.length > maxPatternLen) maxPatternLen = v.length;
  let ringSize = 1;
  while (ringSize < maxPatternLen + 1) ringSize <<= 1;
  const ringMask = ringSize - 1;
  const ringStart = new Int32Array(ringSize);
  const ringFirst = new Uint8Array(ringSize);
  const kmpState = new Int32Array(patterns.length);
  let raw: Array<[number, number]> = [];
  let n = 0; // decoded bytes emitted so far
  let st = 0; // Aho-Corasick state
  // Feeds one decoded byte of the text unit starting at `start` (ending at `end`). A match must
  // begin on a unit's first byte and end on a unit's last byte (always true for valid UTF-8
  // patterns; the check keeps a malformed stream from yielding a half-character span).
  const emit = (b: number, start: number, first: number, last: boolean, end: number): void => {
    const i = n++;
    const slot = i & ringMask;
    ringStart[slot] = start;
    ringFirst[slot] = first;
    if (acNext) {
      // Only the longest pattern ending at a state is reported: any shorter one ending there is a
      // suffix of it, so its span is contained in the longer span.
      st = b > 255 ? 0 : acNext[st * 256 + b];
      const m = acLen[st];
      if (m > 0 && last) {
        const a = (i - m + 1) & ringMask;
        if (ringFirst[a] === 1) raw.push([ringStart[a], end]);
      }
    } else {
      for (let pi = 0; pi < patterns.length; pi++) {
        const v = patterns[pi];
        let k = kmpState[pi];
        if (k === 0 && b !== v[0]) continue;
        const f = patternFailures[pi], m = v.length;
        while (k > 0 && b !== v[k]) k = f[k - 1];
        if (b === v[k]) k++;
        if (k === m) {
          if (last) {
            const a = (i - m + 1) & ringMask;
            if (ringFirst[a] === 1) raw.push([ringStart[a], end]);
          }
          k = f[k - 1];
        }
        kmpState[pi] = k;
      }
    }
  };
  // Returns merged [start, end) spans of s whose percent-decoding contains a secret.
  const matchSpans = (s: string): Array<[number, number]> => {
    if (patterns.length === 0 || s.indexOf("%") < 0) return [];
    const len = s.length;
    raw = [];
    n = 0;
    st = 0;
    kmpState.fill(0);
    for (let i = 0; i < len; ) {
      const c = s.charCodeAt(i);
      if (c === 37 && i + 2 < len && hexVal(s.charCodeAt(i + 1)) >= 0 && hexVal(s.charCodeAt(i + 2)) >= 0) {
        emit(hexVal(s.charCodeAt(i + 1)) * 16 + hexVal(s.charCodeAt(i + 2)), i, 1, true, i + 3);
        i += 3;
      } else if (c < 0x80) {
        emit(c, i, 1, true, i + 1);
        i++;
      } else if (c < 0x800) {
        emit(0xc0 | (c >> 6), i, 1, false, i + 1);
        emit(0x80 | (c & 63), i, 0, true, i + 1);
        i++;
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < len && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(i + 1) - 0xdc00);
        emit(0xf0 | (cp >> 18), i, 1, false, i + 2);
        emit(0x80 | ((cp >> 12) & 63), i, 0, false, i + 2);
        emit(0x80 | ((cp >> 6) & 63), i, 0, false, i + 2);
        emit(0x80 | (cp & 63), i, 0, true, i + 2);
        i += 2;
      } else if (c >= 0xd800 && c <= 0xdfff) {
        emit(0x100, i, 1, true, i + 1); // lone surrogate: matches nothing
        i++;
      } else {
        emit(0xe0 | (c >> 12), i, 1, false, i + 1);
        emit(0x80 | ((c >> 6) & 63), i, 0, false, i + 1);
        emit(0x80 | (c & 63), i, 0, true, i + 1);
        i++;
      }
    }
    const found = raw;
    raw = [];
    if (found.length === 0) return found;
    found.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
    const merged: Array<[number, number]> = [found[0]];
    for (let i = 1; i < found.length; i++) {
      const last = merged[merged.length - 1];
      if (found[i][0] <= last[1]) {
        if (found[i][1] > last[1]) last[1] = found[i][1];
      } else merged.push(found[i]);
    }
    return merged;
  };
  const replaceSpans = (s: string, spans: Array<[number, number]>, marker: string): string => {
    if (spans.length === 0) return s;
    let out = "", at = 0;
    for (const [a, b] of spans) {
      out += s.slice(at, a) + marker;
      at = b;
    }
    return out + s.slice(at);
  };
  const survivors = (s: string): boolean => ordered.some((v) => s.includes(v)) || matchSpans(s).length > 0;
  // KMP failure functions, computed once per variant when the redactor is
  // built; matching itself allocates nothing.
  const failures = ordered.map((v) => {
    const f = new Int32Array(v.length);
    let k = 0;
    for (let i = 1; i < v.length; i++) {
      while (k > 0 && v[i] !== v[k]) k = f[k - 1];
      if (v[i] === v[k]) k++;
      f[i] = k;
    }
    return f;
  });
  // Scans s for every overlapping occurrence of v in O(len(v) + len(s)).
  // The sink receives (start, end); callers supply a counting sink first and
  // a recording sink only when something matched, so echo-free strings
  // allocate nothing.
  const scan = (v: string, f: Int32Array, s: string, sink: (start: number, end: number) => void): void => {
    let k = 0;
    for (let i = 0; i < s.length; i++) {
      while (k > 0 && s[i] !== v[k]) k = f[k - 1];
      if (s[i] === v[k]) k++;
      if (k === v.length) {
        sink(i - k + 1, i + 1);
        k = f[k - 1];
      }
    }
  };
  const redact = (s: string): string => {
    const spans = matchSpans(s);
    let out = replaceSpans(s, spans, PASSWORD_REDACTED);
    for (const v of ordered) out = out.split(v).join(PASSWORD_REDACTED);
    if (survivors(out)) {
      out = replaceSpans(s, spans, blocker);
      for (const v of ordered) out = out.split(v).join(blocker);
    }
    return out;
  };
  // Capture-window redaction for strings captured longer than they may be
  // displayed (visible limit + maxVariantLength). Plain redact shrinks each
  // echo to a short marker, which would pull text that sat beyond the display
  // limit — including an echo the capture boundary cut mid-secret, which no
  // variant matches — into the displayed slice. Instead, every occurrence of
  // every variant is marked (overlapping occurrences included, so no
  // occurrence escapes marking) and the display string is rendered from the
  // first `visible` characters with marked spans replaced by the marker:
  // positions stay stable, and a span the slice cuts still renders as a
  // marker, so no fragment of an echo can survive the boundary. When the
  // marker render exceeds the cap (a span shorter than the 10-char marker)
  // or fails the postcondition (adjacent markers, or marker and page text,
  // reassembling a variant), marked spans are dropped entirely: unmasked
  // text is occurrence-free by construction, so that render keeps the length
  // promise. The join of two unmasked fragments across a dropped span can
  // still theoretically form a variant; that final case renders the single
  // blocker character, which no variant contains.
  const redactCapped = (s: string, visible: number): string => {
    const mspans = matchSpans(s);
    let count = mspans.length;
    for (let vi = 0; vi < ordered.length; vi++) scan(ordered[vi], failures[vi], s, () => { count++; });
    if (count === 0) return s.slice(0, visible);
    // Difference-array coverage: each occurrence adds +1 at its start and -1
    // at its end; one prefix pass turns that into the coverage mask. Every
    // overlapping occurrence is recorded in O(1), so a hostile
    // self-repeating echo costs linear work, never a fill per match.
    const diff = new Int32Array(s.length + 1);
    for (const [a, b] of mspans) {
      diff[a]++;
      diff[b]--;
    }
    for (let vi = 0; vi < ordered.length; vi++) scan(ordered[vi], failures[vi], s, (a, b) => { diff[a]++; diff[b]--; });
    const mask = new Uint8Array(s.length);
    let run = 0;
    for (let i = 0; i < s.length; i++) {
      run += diff[i];
      mask[i] = run > 0 ? 1 : 0;
    }
    const limit = Math.min(visible, s.length);
    let out = "";
    let i = 0;
    while (i < limit) {
      if (mask[i]) {
        out += PASSWORD_REDACTED;
        while (i < s.length && mask[i]) i++;
      } else {
        out += s[i++];
      }
    }
    if (out.length > visible || survivors(out)) {
      out = "";
      for (let j = 0; j < limit; j++) if (!mask[j]) out += s[j];
      if (survivors(out)) return blocker;
    }
    return out;
  };
  const redactDeep = (value: unknown, depth = 0): any => {
    if (depth > 12) return value;
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
    if (value && typeof value === "object" && (value.constructor === Object || value.constructor === undefined)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, depth + 1);
      return out;
    }
    return value;
  };
  return { redact, redactDeep, redactCapped, maxVariantLength: Math.max(ordered[0]?.length ?? 0, ...patterns.map((p) => p.length * 3)) };
}

/** Reads a secret from an arbitrary local path (CLI only; the caller is human). */
export async function readSecretFromPath(path: string): Promise<Buffer> {
  return readFile(path);
}

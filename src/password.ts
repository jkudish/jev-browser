// Credential delivery for password fill. The value enters through one of
// three channels (stdin, a validated one-shot handoff file, or a
// JEV_PASSWORD_* environment variable), lives in memory for a single run,
// and is redacted from every model-facing and serialized output. It must
// never appear in argv, tool arguments, the task, model context, traces,
// screenshots, or error messages.
import { chmod, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

/** Naming a variable with this prefix is the operator's opt-in for password_env. */
export const PASSWORD_ENV_PREFIX = "JEV_PASSWORD_";
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
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  return url.origin;
}

/** The handoff directory for password files. Override for tests and containers. */
export function handoffDir(): string {
  return process.env.JEV_BROWSER_HANDOFF_DIR || resolve(homedir(), ".jev-browser", "handoff");
}

/** The handoff directory must be a private directory owned by this user. */
export async function ensureHandoffDir(dir = handoffDir()): Promise<void> {
  const resolved = resolve(dir);
  const st = await lstat(resolved).catch(() => null);
  if (st) {
    if (!st.isDirectory()) throw new Error(`handoff directory ${resolved} is not a directory`);
    if (st.uid !== process.getuid!()) throw new Error(`handoff directory ${resolved} is not owned by this user`);
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
    after.uid !== process.getuid!() ||
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
  // Code points, not UTF-16 units: two emoji must not count as four characters.
  if ([...text].length < MIN_SECRET_CHARS) throw new Error(`${label} is shorter than ${MIN_SECRET_CHARS} characters`);
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
 * rejected secret must not be left on disk.
 */
export async function readHandoffSecret(path: string, dir = handoffDir()): Promise<Buffer> {
  if (!isAbsolute(path)) throw new Error("password_file must be an absolute path inside the handoff directory");
  const resolvedPath = resolve(path);
  const resolvedDir = resolve(dir);
  const rel = relative(resolvedDir, resolvedPath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.includes("/") || rel.includes("\\")) {
    throw new Error(`password_file must be a file directly inside the handoff directory ${resolvedDir}, not a nested path`);
  }
  await ensureHandoffDir(resolvedDir);
  const fh = await open(resolvedPath, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  let unlinked = false;
  try {
    const st = await fh.stat(); // fstat on the pinned descriptor
    if (!st.isFile()) throw new Error("password_file is not a regular file");
    if (st.uid !== process.getuid!()) throw new Error("password_file is not owned by this user");
    if ((st.mode & 0o777) !== 0o600) throw new Error("password_file must be mode 0600; run chmod 600 on it and retry");
    if (st.nlink !== 1) throw new Error("password_file has multiple hard links");
    if (st.size === 0) throw new Error("password_file is empty");
    if (st.size > MAX_SECRET_BYTES) throw new Error(`password_file exceeds ${MAX_SECRET_BYTES} bytes`);
    // The pathname must still name this exact inode: a replacement between
    // open and unlink would delete a different file than the one validated.
    const named = await lstat(resolvedPath).catch(() => null);
    if (!named || named.ino !== st.ino || named.dev !== st.dev) {
      throw new Error("password_file was replaced while opening; retry with a fresh file");
    }
    await unlink(resolvedPath);
    unlinked = true;
    const post = await fh.stat();
    if (post.nlink !== 0) throw new Error("password_file still has links after being consumed; refusing to trust it");
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const { bytesRead } = await fh.read(buf, read, st.size - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buf.subarray(0, read);
  } catch (error) {
    if (!unlinked) await unlink(resolvedPath).catch(() => {}); // one-shot even on failure
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
 */
export function readSecretFromEnv(name: string): Buffer {
  if (!name.startsWith(PASSWORD_ENV_PREFIX) || !ENV_NAME_RE.test(name)) {
    throw new Error(`password_env must name a ${PASSWORD_ENV_PREFIX}* variable; giving a variable that name is the opt-in`);
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
 * nonempty DEBUG and DEBUG_FILE outright.
 */
export function assertNoPlaywrightDebug(): void {
  const pwdebug = process.env.PWDEBUG;
  if (pwdebug !== undefined && pwdebug !== "" && pwdebug !== "0") {
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
}

/**
 * Per-run redactor covering the representations a page can echo back: the
 * raw value, its percent-encoded forms (URLs), and its HTML-entity forms.
 * Applied to every model-facing state, trace, error, and result payload.
 */
export function makeRedactor(secret: string): Redactor {
  const variants = new Set<string>([secret]);
  // Percent encodings: encodeURIComponent (both hex cases) and the stricter
  // application/x-www-form-urlencoded serialization (space becomes +, more
  // punctuation is escaped), which is what URLSearchParams and form submits
  // produce.
  const pct = encodeURIComponent(secret);
  variants.add(pct);
  variants.add(pct.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
  variants.add(new URLSearchParams({ x: secret }).toString().slice(2));
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
  const ordered = Array.from(variants)
    .filter((v) => v.length >= MIN_SECRET_CHARS)
    .sort((a, b) => b.length - a.length);
  const redact = (s: string): string => {
    for (const v of ordered) s = s.split(v).join(PASSWORD_REDACTED);
    return s;
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
  return { redact, redactDeep };
}

/** Reads a secret from an arbitrary local path (CLI only; the caller is human). */
export async function readSecretFromPath(path: string): Promise<Buffer> {
  return readFile(path);
}

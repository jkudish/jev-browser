import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildActionSpace,
  buildCriteria,
  heuristicQuery,
  isNoiseHref,
  isNoiseName,
  MAX_ELEMENTS,
  pickAlternate,
} from "../dist/lib.js";

const el = (over = {}) => ({
  attr: "j1",
  tag: "a",
  role: "link",
  text: "Espresso",
  href: "https://en.wikipedia.org/wiki/Espresso",
  typeAttr: "",
  clickable: true,
  typeable: false,
  ...over,
});

test("noise names are filtered", () => {
  assert.equal(isNoiseName("Jump up"), true);
  assert.equal(isNoiseName("[23]"), true);
  assert.equal(isNoiseName(""), true);
  assert.equal(isNoiseName("Espresso"), false);
});

test("noise hrefs are filtered, buttons without hrefs survive", () => {
  assert.equal(isNoiseHref("#cite-1"), true);
  assert.equal(isNoiseHref("javascript:void(0)"), true);
  assert.equal(isNoiseHref("mailto:x@y.z"), true);
  assert.equal(isNoiseHref("https://example.com"), false);
  assert.equal(isNoiseHref(""), false);
});

test("buildActionSpace dedupes hrefs, assigns kinds, caps size", () => {
  const raw = [
    el(),
    el({ attr: "j2", text: "Espresso again", href: "https://en.wikipedia.org/wiki/Espresso#section" }),
    el({ attr: "j3", tag: "input", role: "textbox", text: "Search", href: "", clickable: false, typeable: true, typeAttr: "text" }),
    el({ attr: "j4", tag: "select", role: "select", text: "Cabin", href: "", clickable: false, typeable: false, selectable: true, options: [{ i: 0, label: "Economy" }, { i: 1, label: "Business" }] }),
    el({ attr: "j5", tag: "input", role: "textbox", text: "pw", href: "", typeable: true, typeAttr: "password" }),
  ];
  const { elements, truncated } = buildActionSpace(raw);
  // dedupe drops j2 (same destination), password input never offered, select survives
  assert.deepEqual(
    elements.map((e) => `${e.kind}_${e.id}`),
    ["click_e1", "type_e2", "select_e3"],
  );
  assert.equal(truncated, false);
  assert.equal(elements[2].options?.length, 2);
});

test("buildActionSpace caps at MAX_ELEMENTS and reports truncation", () => {
  const many = Array.from({ length: 400 }, (_, i) => el({ attr: `j${i + 1}`, text: `Link ${i}`, href: `https://x.example/${i}` }));
  const { elements, truncated } = buildActionSpace(many);
  assert.equal(elements.length, MAX_ELEMENTS);
  assert.equal(truncated, true);
});

test("buildCriteria stays within the Choice option limit and includes controls", () => {
  const many = Array.from({ length: MAX_ELEMENTS }, (_, i) =>
    el({ attr: `j${i + 1}`, text: `Link ${i}`, href: `https://x.example/${i}` }),
  );
  const { elements } = buildActionSpace(many);
  const criteria = buildCriteria(elements);
  assert.ok(Object.keys(criteria).length <= 255);
  for (const control of ["scroll_down", "scroll_up", "back", "done"]) {
    assert.ok(criteria[control], `missing control ${control}`);
  }
});

test("pickAlternate returns next-best non-excluded option", () => {
  const alternate = pickAlternate(
    { click_e1: 0.2, click_e2: 0.5, back: 0.9, click_e3: 0.3 },
    new Set(["click_e2"]),
  );
  assert.equal(alternate, "click_e3"); // back is never chosen as an alternate
  assert.equal(pickAlternate({ a: 0 }, new Set()), null);
});

test("heuristicQuery strips task boilerplate", () => {
  assert.equal(heuristicQuery("Search Wikipedia for the article about Ristretto and stop on it"), "ristretto");
});

// ── Password delivery (src/password.ts) ──────────────────────────────────────
import { mkdtemp, mkdir, writeFile, chmod, symlink, rm, stat, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTrustedOrigin,
  makeRedactor,
  validateSecretBuffer,
  readHandoffSecret,
  readSecretFromEnv,
  assertNoPlaywrightDebug,
  PASSWORD_REDACTED,
} from "../dist/password.js";

test("parseTrustedOrigin accepts exact origins, rejects everything looser", () => {
  assert.equal(parseTrustedOrigin("https://acme.com"), "https://acme.com");
  assert.equal(parseTrustedOrigin("https://acme.com:8443"), "https://acme.com:8443");
  assert.equal(parseTrustedOrigin("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.equal(parseTrustedOrigin("http://localhost:8080"), "http://localhost:8080");
  assert.equal(parseTrustedOrigin("http://[::1]:9000"), "http://[::1]:9000");
  assert.equal(parseTrustedOrigin(null), null);
  assert.equal(parseTrustedOrigin("https://acme.com/login"), null); // path
  assert.equal(parseTrustedOrigin("https://acme.com?a=1"), null); // query
  assert.equal(parseTrustedOrigin("http://acme.com"), null); // http off loopback
  assert.equal(parseTrustedOrigin("https://user:pw@acme.com"), null); // credentials
  assert.equal(parseTrustedOrigin("not a url"), null);
});

test("validateSecretBuffer keeps exact bytes and rejects bad input", () => {
  assert.equal(validateSecretBuffer(Buffer.from("hunter2extra")), "hunter2extra");
  assert.equal(validateSecretBuffer(Buffer.from(" lead and trail ")), " lead and trail "); // never trimmed
  assert.throws(() => validateSecretBuffer(Buffer.alloc(0)), /empty/);
  assert.throws(() => validateSecretBuffer(Buffer.from("abc")), /shorter/);
  assert.throws(() => validateSecretBuffer(Buffer.from([0xff, 0xfe, 0xfd, 0xfc])), /UTF-8/);
  assert.throws(() => validateSecretBuffer(Buffer.concat([Buffer.from("abcdef"), Buffer.alloc(4096)])), /exceeds/);
  // CR/LF can never be filled: password inputs strip them, so an echo of the
  // stripped value would match no redaction variant.
  assert.throws(() => validateSecretBuffer(Buffer.from("abcdef\n")), /line break/);
  assert.throws(() => validateSecretBuffer(Buffer.from("abcdef\r")), /line break/);
  assert.throws(() => validateSecretBuffer(Buffer.from("abc\r\ndef")), /line break/);
  assert.throws(() => validateSecretBuffer(Buffer.from("abcdef\x01")), /control character/);
  assert.throws(() => validateSecretBuffer(Buffer.from("abcdef\x7f")), /control character/);
  assert.throws(() => validateSecretBuffer(Buffer.from("abcdef\x9f")), /control character/); // C1: YAML serializes these as \xNN escapes
  assert.throws(() => validateSecretBuffer(Buffer.from("abcd\tefgh")), /control character/);
  // A secret whose whitespace-normalized echo would fall below the safe
  // redaction length is rejected: pages echo values with collapsed
  // whitespace, and a variant that short would match ordinary words.
  assert.throws(() => validateSecretBuffer(Buffer.from("a  b")), /collapses below/);
  assert.throws(() => validateSecretBuffer(Buffer.from(" a  b ")), /collapses below/);
  assert.throws(() => validateSecretBuffer(Buffer.from("a\u200bb\u00adc")), /collapses below/); // zero-width stripped by name resolution
  assert.equal(validateSecretBuffer(Buffer.from("abcd  efgh")), "abcd  efgh"); // normalizes to 9, fine
});

test("redactor covers raw, URL-encoded, form-encoded, and HTML-entity echoes, deeply", () => {
  const secret = "p@ss&word=1";
  const { redact, redactDeep } = makeRedactor(secret);
  assert.equal(redact(`echo ${secret} done`), `echo ${PASSWORD_REDACTED} done`);
  assert.equal(redact(`url?q=${encodeURIComponent(secret)}`), `url?q=${PASSWORD_REDACTED}`);
  assert.ok(!redact(secret.replace(/&/g, "&amp;")).includes("p@ss")); // textContent serialization: only & escaped
  assert.ok(!redact(Array.from(secret, (c) => `&#${c.codePointAt(0)};`).join("")).includes("word"));
  const deep = redactDeep({ a: [secret], nested: { b: `x${secret}y` }, keep: 42 });
  assert.ok(!JSON.stringify(deep).includes(secret));
  assert.equal(deep.keep, 42);

  // application/x-www-form-urlencoded: space becomes + and more punctuation
  // is percent-escaped than encodeURIComponent does.
  const spaced = "ab cd!";
  const form = makeRedactor(spaced);
  const formEcho = new URLSearchParams({ q: spaced }).toString();
  assert.notEqual(formEcho, encodeURIComponent(spaced)); // the encodings really differ
  const formOut = form.redact(formEcho);
  assert.ok(!formOut.includes(spaced) && !formOut.includes("cd!") && formOut.includes(PASSWORD_REDACTED));

  // The partial HTML serializations real DOM APIs produce: textContent
  // escapes only & and <; attribute serialization escapes & < > " '.
  const punct = "a'b&c";
  const ent = makeRedactor(punct);
  for (const chars of ["&", "&<", '&<>"\'']) {
    const escaped = punct.replace(new RegExp(`[${chars}]`, "g"), (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
    const out = ent.redact(escaped);
    assert.ok(!out.includes(punct) && !out.includes(escaped), `variant ${chars} should be fully replaced`);
    assert.ok(out.includes(PASSWORD_REDACTED), `variant ${chars} should be replaced, not dropped`);
  }

  // Pages normalize whitespace when echoing into single-space contexts
  // (collapsed DOM text, attributes): the normalized echo must still match.
  const odd = "a  b\tc";
  const norm = makeRedactor(odd);
  const collapsed = odd.replace(/\s+/g, " ");
  assert.notEqual(collapsed, odd); // the echo really is a different string
  const normOut = norm.redact(`x${collapsed}y`);
  assert.ok(!normOut.includes(collapsed), "normalized echo is fully replaced");
  assert.ok(normOut.includes(PASSWORD_REDACTED), "normalized echo is replaced, not dropped");

  // Markdown renderers backslash-escape punctuation: an echo inside rendered
  // markdown shows the escaped form.
  const md = "a*b_c[d]";
  const mdr = makeRedactor(md);
  const mdEcho = md.replace(/([\\`*_\[\]])/g, "\\$1");
  assert.ok(!mdr.redact(`lead ${mdEcho} tail`).includes(mdEcho));
  assert.ok(mdr.redact(`lead ${mdEcho} tail`).includes(PASSWORD_REDACTED));

  // ARIA snapshots serialize names into quoted YAML: quotes and backslashes
  // are backslash-escaped inside them, single quotes are doubled when the
  // value needs single quoting, and zero-width characters are stripped from
  // accessible names before serialization.
  const quoted = 'ab"cd';
  const ar = makeRedactor(quoted);
  const ariaEcho = quoted.replace(/(["\\])/g, "\\$1");
  assert.ok(!ar.redact(`- textbox "Username": ${ariaEcho}`).includes(ariaEcho));
  assert.ok(ar.redact(`- textbox "Username": ${ariaEcho}`).includes(PASSWORD_REDACTED));
  const single = "ab'cd{ef";
  const sr = makeRedactor(single);
  const singleEcho = single.replace(/'/g, "''");
  assert.ok(!sr.redact(`key: '${singleEcho}'`).includes(singleEcho));
  assert.ok(sr.redact(`key: '${singleEcho}'`).includes(PASSWORD_REDACTED));
  // Playwright composes both stages: JSON.stringify the name (escaping
  // quotes and backslashes), then YAML single-quote the assembled value
  // (doubling apostrophes). A secret through both looks like
  // ab''cd\"{ef and must match the composed variant.
  const both = `ab'cd"{ef`;
  const br = makeRedactor(both);
  const composed = both.replace(/(["\\])/g, "\\$1").replace(/'/g, "''");
  assert.notEqual(composed, both.replace(/'/g, "''")); // the stages really compose here
  assert.ok(!br.redact(`key: '${composed}'`).includes(composed));
  assert.ok(br.redact(`key: '${composed}'`).includes(PASSWORD_REDACTED));
  const zw = "ab\u200bcd\u00adef";
  const zr = makeRedactor(zw);
  const zwEcho = zw.replace(/[\u200b\u00ad]/g, "");
  assert.ok(!zr.redact(`- link ${zwEcho}`).includes(zwEcho));
  assert.ok(zr.redact(`- link ${zwEcho}`).includes(PASSWORD_REDACTED));

  // Capture windows are sized from the longest variant: every representation
  // the redactor can name must fit whole inside visible-limit + maxVariantLength.
  for (const s of [secret, spaced, punct, odd, md]) {
    const r = makeRedactor(s);
    assert.ok(r.maxVariantLength >= s.length, "raw secret is itself a variant");
    assert.ok(r.maxVariantLength >= encodeURIComponent(s).length, "URL-encoded variant length is covered");
    assert.ok(r.maxVariantLength >= [...s].map((c) => `&#${c.codePointAt(0)};`.length).reduce((a, b) => a + b, 0), "numeric entity variant length is covered");
  }
});

test("buildActionSpace offers fill_password only when a password source is active", () => {
  const raw = [
    el({ attr: "j1", tag: "input", role: "textbox", text: "Username", href: "", clickable: false, typeable: true, typeAttr: "text" }),
    el({ attr: "j2", tag: "input", role: "textbox", text: "Password", href: "", clickable: false, typeable: false, typeAttr: "password", passwordInput: true }),
  ];
  const off = buildActionSpace(raw);
  assert.deepEqual(off.elements.map((e) => `${e.kind}_${e.id}`), ["type_e1"]);
  const on = buildActionSpace(raw, { passwordActive: true });
  assert.deepEqual(on.elements.map((e) => `${e.kind}_${e.id}`), ["type_e1", "fill_password_e2"]);
  assert.match(on.elements[1].description, /"Password"/);
  // A nameless password field is still offered, with a generic label.
  const nameless = buildActionSpace(
    [el({ attr: "j3", tag: "input", role: "textbox", text: "", href: "", clickable: false, typeable: false, typeAttr: "password", passwordInput: true })],
    { passwordActive: true },
  );
  assert.match(nameless.elements[0].description, /"password"/);
});

test("readHandoffSecret consumes a valid one-shot file and deletes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-handoff-"));
  await chmod(dir, 0o700);
  const file = join(dir, "pw.1");
  await writeFile(file, "super-secret-value", { mode: 0o600 });
  const buf = await readHandoffSecret(file, dir);
  assert.equal(buf.toString(), "super-secret-value");
  await assert.rejects(() => stat(file), /ENOENT/); // unlinked after read
  await rm(dir, { recursive: true, force: true });
});

test("readHandoffSecret rejects the attack shapes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-handoff-"));
  await chmod(dir, 0o700);
  const good = join(dir, "good");
  await writeFile(good, "super-secret-value", { mode: 0o600 });

  await assert.rejects(() => readHandoffSecret("relative/path", dir), /absolute/);
  await assert.rejects(() => readHandoffSecret("/etc/passwd", dir), /inside the handoff directory/);
  await assert.rejects(() => readHandoffSecret(dir, dir), /inside the handoff directory/); // the dir itself
  const subdir = join(dir, "subdir");
  await mkdir(subdir, { mode: 0o700 });
  await assert.rejects(() => readHandoffSecret(subdir, dir), /regular file/); // a directory, not a file

  // Nested paths are refused outright: an intermediate symlink directory
  // could otherwise redirect a basename-only rule anywhere on disk.
  const nestedFile = join(subdir, "pw");
  await writeFile(nestedFile, "super-secret-value", { mode: 0o600 });
  await assert.rejects(() => readHandoffSecret(nestedFile, dir), /directly inside/);

  // A handoff directory that is itself a symlink to a valid-looking directory.
  // The anchor is the symlink, so the basename-only containment rule passes
  // and only the realpath check in ensureHandoffDir can catch it.
  const realDir = await mkdtemp(join(tmpdir(), "jev-real-"));
  await chmod(realDir, 0o700);
  const realFile = join(realDir, "pw");
  await writeFile(realFile, "super-secret-value", { mode: 0o600 });
  const linkedDir = join(dir, "linkeddir");
  await symlink(realDir, linkedDir);
  await assert.rejects(() => readHandoffSecret(join(linkedDir, "pw"), linkedDir), /not a directory|symlink-free/);
  await rm(realDir, { recursive: true, force: true });

  const linked = join(dir, "linked");
  await symlink(good, linked);
  await assert.rejects(() => readHandoffSecret(linked, dir), /symlink|ELOOP|no such/i);

  const loose = join(dir, "loose");
  await writeFile(loose, "super-secret-value", { mode: 0o644 });
  await assert.rejects(() => readHandoffSecret(loose, dir), /0600/);
  await assert.rejects(() => stat(loose), /ENOENT/); // one-shot: consumed even on rejection

  const hardlinked = join(dir, "hard");
  const hardSource = join(dir, "hardsrc");
  await writeFile(hardSource, "super-secret-value", { mode: 0o600 });
  await link(hardSource, hardlinked);
  await assert.rejects(() => readHandoffSecret(hardlinked, dir), /hard links/);

  const empty = join(dir, "empty");
  await writeFile(empty, "", { mode: 0o600 });
  await assert.rejects(() => readHandoffSecret(empty, dir), /empty/);

  const big = join(dir, "big");
  await writeFile(big, "x".repeat(5000), { mode: 0o600 });
  await assert.rejects(() => readHandoffSecret(big, dir), /exceeds/);

  await rm(dir, { recursive: true, force: true });
});

test("validateSecretBuffer counts code points, not UTF-16 units", () => {
  assert.throws(() => validateSecretBuffer(Buffer.from("🐟🐟")), /shorter/); // 2 code points, 4 UTF-16 units
  assert.equal(validateSecretBuffer(Buffer.from("🐟🐟xy")), "🐟🐟xy"); // 4 code points, passes
});

test("readSecretFromEnv enforces the JEV_PASSWORD_ prefix before lookup", () => {
  process.env.JEV_PASSWORD_UNITTEST = "env-carried-secret";
  assert.equal(readSecretFromEnv("JEV_PASSWORD_UNITTEST").toString(), "env-carried-secret");
  assert.throws(() => readSecretFromEnv("TYPESAFE_API_KEY"), /JEV_PASSWORD_/);
  assert.throws(() => readSecretFromEnv("OPENAI_API_KEY"), /JEV_PASSWORD_/);
  assert.throws(() => readSecretFromEnv("JEV_PASSWORD_MISSING"), /not set/);
  assert.throws(() => validateSecretBuffer(readSecretFromEnv("JEV_PASSWORD_UNITTEST").subarray(0, 0)), /empty/);
  delete process.env.JEV_PASSWORD_UNITTEST;
});

test("assertNoPlaywrightDebug refuses debug modes that log filled values", () => {
  const saved = { PWDEBUG: process.env.PWDEBUG, DEBUG: process.env.DEBUG, DEBUG_FILE: process.env.DEBUG_FILE };
  try {
    process.env.PWDEBUG = "1";
    assert.throws(() => assertNoPlaywrightDebug(), /PWDEBUG/);
    delete process.env.PWDEBUG;

    // Wildcards and mixed specs include Playwright's namespaces, so any
    // nonempty DEBUG is refused: exact deny-lists are unreliable here.
    for (const spec of ["pw:api", "app,pw:channel", "*", "pw:*", "app pw:api", "app,pw:something-else"]) {
      process.env.DEBUG = spec;
      assert.throws(() => assertNoPlaywrightDebug(), /DEBUG/, spec);
    }
    process.env.DEBUG = "";
    assertNoPlaywrightDebug(); // explicitly empty is fine
    delete process.env.DEBUG;

    process.env.DEBUG_FILE = "/tmp/pw-debug.log";
    assert.throws(() => assertNoPlaywrightDebug(), /DEBUG_FILE/);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});


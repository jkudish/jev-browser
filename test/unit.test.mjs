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
  // dedupe drops j2 (same destination), password input never offered, select survives;
  // a text field with no enterSubmittable flag offers type only
  assert.deepEqual(
    elements.map((e) => `${e.kind}_${e.id}`),
    ["click_e1", "type_e2", "select_e3"],
  );
  assert.equal(truncated, false);
  assert.equal(elements[2].options?.length, 2);
});

test("buildActionSpace stamps submit controls instead of click", () => {
  const raw = [
    el({ attr: "j1", tag: "button", role: "button", text: "Join", href: "", typeAttr: "submit", clickable: true, submitControl: true }),
    el({ attr: "j2", tag: "input", role: "button", text: "Go", href: "", typeAttr: "submit", clickable: true, submitControl: true }),
    el({ attr: "j3", tag: "button", role: "button", text: "Cancel", href: "", typeAttr: "button", clickable: true }),
  ];
  const { elements } = buildActionSpace(raw);
  assert.deepEqual(
    elements.map((e) => `${e.kind}_${e.id}`),
    ["submit_e1", "submit_e2", "click_e3"],
  );
  assert.equal(elements[0].submitVia, "click");
  assert.match(elements[0].description, /button "Join" \(submit the form now\)/);
  assert.equal(elements[1].submitVia, "click");
});

test("buildActionSpace offers submit alongside type on enter-submittable fields", () => {
  const raw = [
    el({ attr: "j1", tag: "input", role: "textbox", text: "Email", href: "", clickable: false, typeable: true, typeAttr: "text", enterSubmittable: true }),
    el({ attr: "j2", tag: "textarea", role: "textbox", text: "Notes", href: "", clickable: false, typeable: true, enterSubmittable: false }),
    el({ attr: "j3", tag: "input", role: "textbox", text: "First name", href: "", clickable: false, typeable: true, typeAttr: "text", enterSubmittable: true }),
  ];
  const { elements } = buildActionSpace(raw);
  assert.deepEqual(
    elements.map((e) => `${e.kind}_${e.id}`),
    ["type_e1", "submit_e2", "type_e3", "type_e4", "submit_e5"],
  );
  assert.equal(elements[1].attr, "j1"); // submit_e2 targets the same stamped element as type_e1
  assert.equal(elements[1].submitVia, "enter");
  assert.match(elements[1].description, /submit the form now/);
  assert.match(elements[0].description, /type without submitting/);
  assert.equal(elements[2].submitVia, undefined); // textareas never offer Enter submit
});

test("buildActionSpace stamps search_eN alone on structurally search-like fields", () => {
  const raw = [
    el({ attr: "j1", tag: "input", role: "textbox", text: "Search Wikipedia", href: "", clickable: false, typeable: true, typeAttr: "search", searchField: true, enterSubmittable: true }),
    el({ attr: "j2", tag: "div", role: "searchbox", text: "Search", href: "", typeable: true, searchField: true, enterSubmittable: true }),
    // a plain text input named/labeled like a search box is NOT search-like: markup only
    el({ attr: "j3", tag: "input", role: "textbox", text: "Search", href: "", clickable: false, typeable: true, typeAttr: "text", name: "q", enterSubmittable: true }),
  ];
  const { elements } = buildActionSpace(raw);
  assert.deepEqual(
    elements.map((e) => `${e.kind}_${e.id}`),
    ["search_e1", "search_e2", "type_e3", "submit_e4"],
  );
  assert.equal(elements[0].submitVia, undefined);
  assert.match(elements[0].description, /type into this search box and run the search/);
});

test("buildCriteria exposes the distinct search, type, and submit wordings", () => {
  const raw = [
    el({ attr: "j1", tag: "input", role: "textbox", text: "Search Wikipedia", href: "", clickable: false, typeable: true, typeAttr: "search", searchField: true, enterSubmittable: true }),
    el({ attr: "j2", tag: "button", role: "button", text: "Join", href: "", typeAttr: "submit", clickable: true, submitControl: true }),
    el({ attr: "j3", tag: "input", role: "textbox", text: "Email", href: "", clickable: false, typeable: true, typeAttr: "text", enterSubmittable: true }),
  ];
  const { elements } = buildActionSpace(raw);
  const criteria = buildCriteria(elements);
  assert.match(criteria["search_e1"], /type into this search box and run the search/);
  assert.match(criteria["submit_e2"], /submit the form now/);
  assert.match(criteria["type_e3"], /type without submitting/);
  assert.match(criteria["submit_e4"], /submit the form now/);
});

test("buildActionSpace caps at MAX_ELEMENTS and reports truncation", () => {
  const many = Array.from({ length: 400 }, (_, i) => el({ attr: `j${i + 1}`, text: `Link ${i}`, href: `https://x.example/${i}` }));
  const { elements, truncated } = buildActionSpace(many);
  assert.equal(elements.length, MAX_ELEMENTS);
  assert.equal(truncated, true);
});

test("buildActionSpace cap holds when fields double up as submit targets", () => {
  const many = Array.from({ length: 400 }, (_, i) =>
    el({ attr: `j${i + 1}`, tag: "input", role: "textbox", text: `Field ${i}`, href: "", clickable: false, typeable: true, typeAttr: "text", enterSubmittable: true }),
  );
  const { elements, truncated } = buildActionSpace(many);
  // every field wants two entries (type + submit); the cap still bounds the list
  assert.equal(elements.length, MAX_ELEMENTS);
  assert.equal(truncated, true);
  assert.ok(elements.some((e) => e.kind === "type") && elements.some((e) => e.kind === "submit"));
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
    { click_e1: 0.2, click_e2: 0.5, back: 0.9, done: 0.8, click_e3: 0.3 },
    new Set(["click_e2"]),
  );
  assert.equal(alternate, "click_e3"); // back and done are never chosen as alternates
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
  assert.equal(parseTrustedOrigin("https://*.example.com"), null); // wildcards are not exact
  assert.equal(parseTrustedOrigin("https://%2A.example.com"), null); // percent-encoded wildcard
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

test("redaction never lets the secret reassemble across markers", () => {
  // A secret built from marker characters reappears inside two adjacent
  // markers: "[REDACTED][REDACTED]" contains "ED][RE". The postcondition
  // must catch it and fall back to the single-character marker.
  const adjacent = makeRedactor("ED][RE");
  const adjOut = adjacent.redact(`a${"ED][RE"}${"ED][RE"}b`);
  assert.ok(!adjOut.includes("ED][RE"), "adjacent echoes must not reassemble the secret across markers");
  assert.ok(!adjOut.includes("REDACTED"), "the fallback marker must not look like the standard one here");

  // A secret shaped like marker-suffix + following text reappears when the
  // marker lands right before text that continues it.
  const span = makeRedactor("ED]next");
  const spanOut = span.redact(`${"ED]next"}next steps`);
  assert.ok(!spanOut.includes("ED]next"), "a marker plus adjacent text must not reassemble the secret");
  assert.ok(!spanOut.includes("REDACTED"), "the fallback marker must not look like the standard one here");

  // A secret contained in the standard marker itself ("DACT" inside
  // "[REDACTED]") is the same class, one occurrence deep.
  const inner = makeRedactor("DACT");
  const innerOut = inner.redact(`x DACT y`);
  assert.ok(!innerOut.includes("DACT"));

  // Normal secrets keep the readable marker, and redaction stays idempotent.
  const normal = makeRedactor("hunter2!");
  const once = normal.redact(`pre hunter2! mid ${encodeURIComponent("hunter2!")} post`);
  assert.ok(once.includes(PASSWORD_REDACTED));
  assert.equal(normal.redact(once), once);
});

test("redactCapped keeps a partially captured echo out of the visible slice", () => {
  const secret = "sup3rs3cr3tvalu3!";
  const { redactCapped } = makeRedactor(secret);
  // Simulate a capture window: visible limit 40, echo at the start, filler,
  // then an echo the capture boundary cut mid-secret starting at position 41 —
  // inside the reach a plain redact's shrinkage (16 chars to a 10-char
  // marker) would pull into the displayed slice.
  const visible = 40;
  const captured = `${secret}${"y".repeat(25)}${secret.slice(0, 8)}`;
  const out = redactCapped(captured, visible);
  // The old redact-then-slice logic shrank the leading echo to a 10-char
  // marker and exposed the first three characters of the partial echo here;
  // assert on every prefix short enough to surface.
  for (let n = 3; n <= secret.length; n++) {
    assert.ok(!out.includes(secret.slice(0, n)), `partial-echo prefix of length ${n} must not surface`);
  }
  assert.ok(out.includes(PASSWORD_REDACTED), "the fully captured echo collapses to the display marker");
  assert.ok(out.length <= visible);

  // Echoes that fit inside the visible window are replaced, not preserved.
  const out2 = redactCapped(`head ${secret} tail`, 80);
  assert.ok(!out2.includes(secret) && out2.includes(PASSWORD_REDACTED));

  // The collapsed marker is held to the same postcondition: the pathological
  // marker-spanning secret must not reappear after collapse either.
  const { redactCapped: capped } = makeRedactor("ED]next");
  const out3 = capped(`${"ED]next"}next steps`, 60);
  assert.ok(!out3.includes("ED]next"));
});

test("redactCapped placeholder hygiene: native collisions, exhaustion, cap", () => {
  // A placeholder character occurring natively in page text must not be
  // collapsed to the display marker: it would misreport page content as
  // redacted.
  const native = makeRedactor("hunter2");
  assert.equal(native.redactCapped("A\u2588B", 80), "A\u2588B");

  // A secret containing every short-form candidate character still redacts:
  // the placeholder is synthesized from the private-use range.
  const hostile = "\u2588\uE000\uE001\uE002\uE003!";
  const hr = makeRedactor(hostile);
  const hOut = hr.redact(`echo ${hostile} end`);
  assert.ok(!hOut.includes(hostile) && hOut.includes(PASSWORD_REDACTED));

  // An input containing every candidate character (the full private-use
  // range) must also redact: the span-mask path never searches for a
  // character absent from the input, so nothing is exhaustible.
  const greedy = makeRedactor("hunter2!");
  let all = "\u2588";
  for (let cp = 0xe000; cp <= 0xf8ff; cp++) all += String.fromCharCode(cp);
  const gOut = greedy.redactCapped(`pre hunter2! ${all} hunter2! post`, 7000);
  assert.ok(!gOut.includes("hunter2!"));
  assert.ok(gOut.includes(PASSWORD_REDACTED));

  // Replacing a 4-character span with the 10-char marker can exceed the
  // visible cap; the drop render keeps the length promise.
  const short4 = makeRedactor("abcd");
  const out = short4.redactCapped("x abcd", 6);
  assert.ok(!out.includes("abcd"));
  assert.ok(out.length <= 6);

  // Overlapping occurrences of a self-repeating secret must all be covered:
  // "aaaa" in "baaaaa" has occurrences at both offsets, and non-overlapping
  // marking would leave the trailing "a" of the second occurrence displayed.
  const ov = makeRedactor("aaaa");
  assert.equal(ov.redactCapped("baaaaa z", 20), "b[REDACTED] z");
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

test("redactor survives secrets that collide with the redaction marker", () => {
  for (const secret of ["[REDACTED]", "REDACTED", "DACT", "ED]he"]) {
    const { redact } = makeRedactor(secret);
    for (const echo of [`x${secret}y`, encodeURIComponent(secret), `a ${secret} b ${secret} c`]) {
      const out = redact(echo);
      assert.ok(!out.includes(secret), `secret ${JSON.stringify(secret)} survived redaction of ${JSON.stringify(echo)}`);
      assert.equal(redact(out), out, "redaction must be stable on its own output");
    }
  }
});

test("redactor covers lowercase percent-encoding of form echoes", () => {
  const secret = "ab cd?";
  const { redact } = makeRedactor(secret);
  const out = redact("ab+cd%3f"); // some servers and proxies lowercase the hex
  assert.ok(!out.includes("cd%3f") && !out.includes(secret));
});

test("assertNoPlaywrightDebug refuses debug modes that log filled values", () => {
  const saved = { PWDEBUG: process.env.PWDEBUG, DEBUG: process.env.DEBUG, DEBUG_FILE: process.env.DEBUG_FILE };
  try {
    process.env.PWDEBUG = "1";
    assert.throws(() => assertNoPlaywrightDebug(), /PWDEBUG/);
    process.env.PWDEBUG = "0";
    assert.throws(() => assertNoPlaywrightDebug(), /PWDEBUG/); // unset, do not zero
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


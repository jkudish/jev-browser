import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildActionSpace,
  buildCriteria,
  heuristicQuery,
  isNoiseHref,
  isNoiseName,
  MAX_ELEMENTS,
  parseCookieSpec,
  pickAlternate,
  resolveCookies,
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
    el({ attr: "j4", tag: "select", role: "select", text: "Cabin", href: "", clickable: false, typeable: false, selectable: true, options: ["Economy", "Business"] }),
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

test("resolveCookies defaults domain to the start URL host and path to /", () => {
  assert.deepEqual(resolveCookies(undefined, "https://example.com/a"), []);
  assert.deepEqual(resolveCookies([], "https://example.com/a"), []);
  assert.deepEqual(
    resolveCookies(
      [
        { name: "session", value: "abc" },
        { name: "pref", value: "x", domain: ".example.com", path: "/app" },
      ],
      "https://app.example.com:8443/start?x=1",
    ),
    [
      { name: "session", value: "abc", domain: "app.example.com", path: "/" },
      { name: "pref", value: "x", domain: ".example.com", path: "/app" },
    ],
  );
  assert.throws(() => resolveCookies([{ name: "", value: "abc" }], "https://example.com"), /name and a value/);
});

test("parseCookieSpec splits on the first = only", () => {
  assert.deepEqual(parseCookieSpec("session=abc"), { name: "session", value: "abc" });
  assert.deepEqual(parseCookieSpec("jwt=eyJ.a=b=="), { name: "jwt", value: "eyJ.a=b==" });
  assert.deepEqual(parseCookieSpec("empty="), { name: "empty", value: "" });
  assert.throws(() => parseCookieSpec("novalue"), /name=value/);
  assert.throws(() => parseCookieSpec("=x"), /name=value/);
});

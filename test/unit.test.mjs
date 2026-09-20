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
    el({ attr: "j4", tag: "select", role: "select", text: "Cabin", href: "", clickable: false, typeable: false, selectable: true, options: ["Economy", "Business"] }),
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

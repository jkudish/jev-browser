// Pure helpers — no browser, no API, fully unit-testable.

/** Max elements offered to Jev per step. TypeSafe Choice supports up to 255 options. */
export const MAX_ELEMENTS = 240;

/** Raw interactive candidate as extracted from the page (already stamped with an attr). */
export interface RawElement {
  attr: string; // data-jev-id attribute value stamped in the page
  tag: string;
  role: string;
  text: string;
  href: string;
  typeAttr: string;
  clickable: boolean;
  typeable: boolean;
  selectable?: boolean; // native <select>
  options?: string[]; // option labels for selects
}

/** Pruned action-space element. */
export interface PageElement {
  id: string; // e1, e2, ...
  attr: string;
  kind: "click" | "type" | "select";
  description: string;
  options?: string[]; // for kind === "select": the native option labels
}

const JUNK_NAMES = new Set([
  "jump up", "jump up to", "jump up to:", "jump to content", "edit", "permalink",
  "permanent link", "cite this page", "donate", "create account", "log in", "talk",
  "contributions", "view history", "read", "source", "hide", "show", "skip to content",
]);

export function isNoiseName(name: string): boolean {
  const lowered = name.trim().toLowerCase();
  if (lowered.length === 0 || lowered.length > 80) return true;
  if (JUNK_NAMES.has(lowered)) return true;
  if (/^[\d\s.,:;()[\]-]+$/.test(lowered)) return true; // citation numbers, lone brackets
  return false;
}

export function isNoiseHref(href: string): boolean {
  if (!href) return false; // buttons and inputs legitimately have no href
  if (href.startsWith("#")) return true;
  if (href.startsWith("javascript:")) return true;
  if (href.startsWith("mailto:") || href.startsWith("tel:")) return true;
  if (href.includes("action=edit")) return true;
  return false;
}

/** Filter, dedupe by destination, cap, and describe the action space for one step. */
export function buildActionSpace(raw: RawElement[]): { elements: PageElement[]; truncated: boolean } {
  const seenHrefs = new Set<string>();
  const elements: PageElement[] = [];
  for (const el of raw) {
    if (elements.length >= MAX_ELEMENTS) break;
    if (isNoiseName(el.text)) continue;
    if (isNoiseHref(el.href)) continue;
    // Never offer to type into password or file inputs.
    if (el.typeable && (el.typeAttr === "password" || el.typeAttr === "file")) continue;
    if (el.href) {
      const key = el.href.split("#")[0];
      if (seenHrefs.has(key)) continue;
      seenHrefs.add(key);
    }
    if (!el.clickable && !el.typeable && !el.selectable) continue;
    const id = `e${elements.length + 1}`;
    const label = el.text.slice(0, 60);
    const kind: "click" | "type" | "select" = el.typeable ? "type" : el.selectable ? "select" : "click";
    const hrefTail = el.href ? ` -> ${el.href.replace(/^https?:\/\//, "").slice(0, 70)}` : "";
    elements.push({
      id,
      attr: el.attr,
      kind,
      description:
        kind === "type"
          ? `${el.tag} "${label}" (type into this field)`
          : kind === "select"
            ? `${el.tag} "${label}" (dropdown; a follow-up picks the option)`
            : `${el.tag} "${label}"${hrefTail}`,
      options: kind === "select" ? (el.options ?? []) : undefined,
    });
  }
  return { elements, truncated: elements.length >= MAX_ELEMENTS };
}

/** Jev Choice criteria for one step: element actions plus loop controls. */
export function buildCriteria(elements: PageElement[]): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const el of elements) {
    criteria[`${el.kind}_${el.id}`] = el.description;
  }
  criteria["scroll_down"] = "Scroll down one screen to reveal more of the page";
  criteria["scroll_up"] = "Scroll up one screen";
  criteria["back"] = "Go back to the previous page; this branch is wrong";
  criteria["done"] = "The task is already complete; stop here";
  return criteria;
}

export function selectorFor(el: PageElement): string {
  return `[data-jev-id="${el.attr}"]`;
}

/** Next-best action from a Choice distribution, excluding known-bad options. */
export function pickAlternate(probabilities: Record<string, number> | undefined, exclude: Set<string>): string | null {
  const ranked = Object.entries(probabilities ?? {}).sort((a, b) => b[1] - a[1]);
  for (const [option, p] of ranked) {
    if (option === "back") continue;
    if (exclude.has(option)) continue;
    if (p <= 0) continue;
    return option;
  }
  return null;
}

const STOP_WORDS = new Set([
  "search", "wikipedia", "the", "a", "an", "article", "about", "for", "find", "stop", "when",
  "you", "are", "on", "it", "and", "to", "of", "called", "page", "site", "website", "navigate",
  "go", "open", "that", "this",
]);

/** Deterministic typing fallback when no small-LLM key is available. */
export function heuristicQuery(task: string): string {
  const words = task
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w));
  return words.slice(0, 6).join(" ");
}

/** jev-1.12 published pricing: input $0.042 per M tokens, output free. */
export const PRICE_PER_MTOK_IN = 0.042;

/** A cookie to seed the browser context with before the first navigation. */
export interface SeedCookie {
  name: string;
  value: string;
  domain?: string; // defaults to the start URL's host
  path?: string; // defaults to "/"
}

/**
 * Resolves seed cookies into Playwright's `addCookies` shape. Domain defaults
 * to the start URL's host so the common case (a session cookie for the site
 * being navigated) needs only a name and value.
 */
export function resolveCookies(
  cookies: SeedCookie[] | undefined,
  startUrl: string,
): Array<{ name: string; value: string; domain: string; path: string }> {
  if (!cookies?.length) return [];
  const host = new URL(startUrl).hostname;
  return cookies.map((c) => {
    if (!c.name || typeof c.value !== "string") throw new Error(`cookie needs a name and a value: ${JSON.stringify(c)}`);
    return { name: c.name, value: c.value, domain: c.domain ?? host, path: c.path ?? "/" };
  });
}

/** Parses a CLI `name=value` cookie spec. The value may itself contain `=`. */
export function parseCookieSpec(spec: string): SeedCookie {
  const eq = spec.indexOf("=");
  if (eq <= 0) throw new Error(`cookie expects name=value, got: ${JSON.stringify(spec)}`);
  return { name: spec.slice(0, eq), value: spec.slice(eq + 1) };
}

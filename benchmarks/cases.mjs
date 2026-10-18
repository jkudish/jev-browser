// Case definitions, fixed before any measured run. `task` and `start` are the
// only fields passed to navigate(); `grade` runs after the attempt, against
// fixture state and the final DOM, and its expectations never reach the agent.
//
// grade(ctx) receives:
//   ctx.result  navigate() return value
//   ctx.state   fixture server state (local suite only)
//   ctx.pages   every Playwright page in the attempt's context
//   ctx.final   the page whose URL equals result.final_url (else the last page)
//   ctx.base    fixture origin
// and returns { pass, evidence, reason }.

const path = (page) => { try { return new URL(page.url()).pathname; } catch { return ""; } };
const writesTo = (state, prefix) => state.writes.filter((w) => w.path.startsWith(prefix));
const noWrites = (state) => state.writes.length === 0;
const norm = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase().replace(/[.!]+$/, "");
const claimed = (r) => r.status === "done" || r.status === "goal_achieved";

export const LOCAL_CASES = [
  {
    id: "nav-new-tab",
    category: "navigation",
    difficulty: "easy",
    mode_sensitive: "popup/new-tab navigation",
    start: "/",
    task: "Open the store's shipping policy.",
    initial_state: "Home page. The shipping policy is linked only from the Help center and opens in a new tab.",
    limits: { maxSteps: 10, maxSeconds: 90 },
    needs_typing: false,
    async grade({ result, final, state }) {
      const finalPath = path(final);
      const pass = finalPath === "/help/shipping" && noWrites(state);
      return { pass, evidence: { final_path: finalPath, result_final_url: result.final_url, writes: state.writes.length }, reason: pass ? "" : `final path ${finalPath}` };
    },
  },
  {
    id: "search-keyboard",
    category: "search",
    difficulty: "medium",
    mode_sensitive: "focus/keyboard input (results render only on an Enter keydown)",
    start: "/help",
    task: "Use the help center search to find the article about getting your money back for a return, and open it.",
    initial_state: "Help center with a search field. The refund article is reachable only through search results.",
    limits: { maxSteps: 10, maxSeconds: 90 },
    needs_typing: false, // search_eN falls back to the keyword heuristic without a typing provider
    async grade({ final, state }) {
      const finalPath = path(final);
      const pass = finalPath === "/help/refunds" && noWrites(state);
      return { pass, evidence: { final_path: finalPath, searches: state.searches }, reason: pass ? "" : state.searches.length ? `searched ${JSON.stringify(state.searches.map((s) => s.q))}; final ${finalPath}` : "no search was run" };
    },
  },
  {
    id: "extract-annual-price",
    category: "extraction",
    difficulty: "medium",
    mode_sensitive: null,
    start: "/pricing",
    task: "Find the price of the Team subscription when it is billed annually, and stop on the page that shows it.",
    initial_state: "Pricing page showing monthly prices; annual prices appear only after selecting the Annual billing tab.",
    limits: { maxSteps: 8, maxSeconds: 75 },
    needs_typing: false,
    async grade({ result, final, state }) {
      const annual = await final.locator("#t-a").getAttribute("aria-selected").catch(() => null);
      const payload = result.page?.content ?? "";
      const inPayload = payload.includes("$290 per year");
      const pass = annual === "true" && inPayload && noWrites(state);
      return { pass, evidence: { annual_tab_selected: annual, payload_has_value: inPayload, payload_excerpt: payload.slice(0, 300) }, reason: pass ? "" : `annual tab ${annual}, value in payload ${inPayload}` };
    },
  },
  {
    id: "form-no-submit",
    category: "multi-field form without submission",
    difficulty: "hard",
    mode_sensitive: "focus/keyboard input",
    start: "/contact",
    task: "Fill in the contact form with the name Ada Lovelace, the email ada@example.com, and the message: Please call me back on Tuesday. Leave the order number empty and do not send the form.",
    initial_state: "Empty contact form with name, email, optional order number, message, and a Send button.",
    limits: { maxSteps: 12, maxSeconds: 120 },
    needs_typing: true,
    async grade({ final, state }) {
      const v = await final.evaluate(() => ({ name: document.getElementById("name")?.value, email: document.getElementById("email")?.value, order: document.getElementById("order")?.value, msg: document.getElementById("msg")?.value })).catch(() => null);
      const fields = v && { name: norm(v.name) === "ada lovelace", email: norm(v.email) === "ada@example.com", order_empty: v.order === "", message: norm(v.msg) === "please call me back on tuesday" };
      const sent = writesTo(state, "/api/contact").length;
      const pass = path(final) === "/contact" && !!fields && Object.values(fields).every(Boolean) && sent === 0 && noWrites(state);
      return { pass, evidence: { values: v, fields, submissions: sent }, reason: pass ? "" : sent ? "form was submitted" : `fields ${JSON.stringify(fields)}` };
    },
  },
  {
    id: "dropdowns",
    category: "dropdowns",
    difficulty: "medium",
    mode_sensitive: null,
    start: "/shipping-estimator",
    task: "In the shipping estimator, get the estimate for Express delivery to Kenya. Do not save it as a default.",
    initial_state: "Two native selects: country (24 options plus a placeholder) and delivery speed (Standard selected).",
    limits: { maxSteps: 8, maxSeconds: 75 },
    needs_typing: false,
    async grade({ final, state }) {
      const v = await final.evaluate(() => ({ country: document.getElementById("country")?.value, speed: document.getElementById("speed")?.value, est: document.getElementById("est")?.textContent })).catch(() => null);
      const pass = v?.country === "Kenya" && v?.speed === "Express" && noWrites(state);
      return { pass, evidence: { ...v, writes: state.writes }, reason: pass ? "" : `country=${v?.country} speed=${v?.speed} writes=${state.writes.length}` };
    },
  },
  {
    id: "filter-sort",
    category: "filtering/sorting",
    difficulty: "medium",
    mode_sensitive: null,
    start: "/shop",
    task: "Show only grinders, sorted by price from lowest to highest.",
    initial_state: "Product table with all 11 products, no category filter, unsorted.",
    limits: { maxSteps: 8, maxSeconds: 75 },
    needs_typing: false,
    async grade({ final, state }) {
      const rows = await final.$$eval("#rows tr", (trs) => trs.map((t) => ({ cat: t.dataset.cat, price: Number(t.dataset.price) }))).catch(() => []);
      const grinders = rows.length === 4 && rows.every((r) => r.cat === "Grinders");
      const ascending = rows.every((r, i) => i === 0 || rows[i - 1].price <= r.price);
      const pass = path(final) === "/shop" && grinders && ascending && noWrites(state);
      return { pass, evidence: { rows }, reason: pass ? "" : `grinders_only=${grinders} ascending=${ascending} rows=${rows.length}` };
    },
  },
  {
    id: "pagination",
    category: "pagination",
    difficulty: "medium",
    mode_sensitive: null,
    start: "/orders",
    task: "Open the details of order A-1022.",
    initial_state: "Orders list page 1 of 5 (newest first, 10 per page); A-1022 is on page 3.",
    limits: { maxSteps: 10, maxSeconds: 90 },
    needs_typing: false,
    async grade({ final, state }) {
      const finalPath = path(final);
      const pass = finalPath === "/orders/A-1022" && noWrites(state);
      return { pass, evidence: { final_path: finalPath }, reason: pass ? "" : `final path ${finalPath}` };
    },
  },
  {
    id: "delayed-content",
    category: "delayed content",
    difficulty: "medium",
    mode_sensitive: "delayed rendering (list appears 3 s after load)",
    start: "/reports",
    task: "Open the Q3 2026 sales summary report.",
    initial_state: "Reports page shows 'Loading reports…' for 3 seconds before the report links render.",
    limits: { maxSteps: 10, maxSeconds: 90 },
    needs_typing: false,
    async grade({ final, state }) {
      const finalPath = path(final);
      const pass = finalPath === "/reports/q3-2026" && noWrites(state);
      return { pass, evidence: { final_path: finalPath }, reason: pass ? "" : `final path ${finalPath}` };
    },
  },
  {
    id: "ambiguous-save",
    category: "ambiguous controls",
    difficulty: "hard",
    mode_sensitive: null,
    start: "/settings",
    task: "Turn on email alerts for new invoices and save the notification preferences. Leave everything else as it is.",
    initial_state: "Settings with a Billing form and a Notifications form; both have a button labelled exactly 'Save'. invoice=off, shipped=on, news=off.",
    limits: { maxSteps: 8, maxSeconds: 75 },
    needs_typing: false,
    async grade({ state }) {
      const n = state.notifications;
      const pass = state.notificationSaves >= 1 && n.invoice === true && n.shipped === true && n.news === false && state.billingSaves === 0;
      return { pass, evidence: { notifications: n, notificationSaves: state.notificationSaves, billingSaves: state.billingSaves }, reason: pass ? "" : `saves notif=${state.notificationSaves} billing=${state.billingSaves} state=${JSON.stringify(n)}` };
    },
  },
  {
    id: "unavailable-target",
    category: "unavailable target",
    difficulty: "hard",
    mode_sensitive: null,
    start: "/shop",
    task: "Add the Moka Express in Midnight Blue to the cart.",
    initial_state: "Shop list. The Moka Express exists but only in Silver and Red; Midnight Blue does not exist.",
    // Correct behavior: add nothing and do not claim success. Ending stuck,
    // at max_steps or on timeout without any cart write passes; claiming done
    // or adding another color fails.
    limits: { maxSteps: 10, maxSeconds: 90 },
    needs_typing: false,
    async grade({ result, state }) {
      const cartWrites = writesTo(state, "/api/cart").length;
      const pass = cartWrites === 0 && !claimed(result) && noWrites(state);
      return { pass, evidence: { status: result.status, cart: state.cart, writes: state.writes }, reason: pass ? "" : cartWrites ? "added an item that does not match" : claimed(result) ? "claimed success for an unavailable target" : "unexpected write" };
    },
  },
  {
    id: "stop-before-submit",
    category: "stop-before-submit",
    difficulty: "hard",
    mode_sensitive: null,
    start: "/cart",
    task: "Go through checkout up to the final order review step, then stop. Do not place the order.",
    initial_state: "Cart with one kettle. Checkout: cart → shipping form (GET submit) → review page with a 'Place order' button.",
    limits: { maxSteps: 10, maxSeconds: 90 },
    needs_typing: false,
    async grade({ result, final, state }) {
      const finalPath = path(final);
      const placed = state.orders.length;
      const pass = finalPath === "/checkout/review" && placed === 0 && claimed(result) && noWrites(state);
      return { pass, evidence: { final_path: finalPath, orders: placed, status: result.status }, reason: pass ? "" : placed ? "placed the order" : finalPath !== "/checkout/review" ? `final path ${finalPath}` : "reached review but did not stop" };
    },
  },
  {
    id: "offscreen-lazy",
    category: "scrolling to offscreen controls",
    difficulty: "medium",
    mode_sensitive: "scrolling (the target link renders only when the page bottom enters the viewport)",
    start: "/product/stagg-kettle",
    task: "From this product page, open the page for registering the product's warranty.",
    initial_state: "Long product page; the warranty registration link is added by an IntersectionObserver at the bottom.",
    limits: { maxSteps: 12, maxSeconds: 100 },
    needs_typing: false,
    async grade({ final, state }) {
      const finalPath = path(final);
      const pass = finalPath === "/warranty/register" && noWrites(state);
      return { pass, evidence: { final_path: finalPath }, reason: pass ? "" : `final path ${finalPath}` };
    },
  },
];

// Live, read-only public smoke suite. Non-GET browser requests are aborted.
// Evidence from these runs is labeled "live": content can change.
export const PUBLIC_CASES = [
  {
    id: "live-wiki-coffee-espresso",
    category: "navigation (README claim)",
    difficulty: "easy",
    start: "https://en.wikipedia.org/wiki/Coffee",
    task: "Navigate to the Wikipedia article about espresso.",
    initial_state: "Live Wikipedia Coffee article.",
    limits: { maxSteps: 10, maxSeconds: 90 },
    async grade({ final }) {
      const p = path(final);
      const pass = /^\/wiki\/Espresso$/i.test(p);
      return { pass, evidence: { final_url: final.url() }, reason: pass ? "" : `final ${final.url()}` };
    },
  },
  {
    id: "live-wiki-search",
    category: "search",
    difficulty: "medium",
    start: "https://en.wikipedia.org/wiki/Main_Page",
    task: "Search Wikipedia for Ada Lovelace and open her article.",
    initial_state: "Live Wikipedia Main Page.",
    limits: { maxSteps: 10, maxSeconds: 90 },
    async grade({ final }) {
      const p = path(final);
      const pass = p === "/wiki/Ada_Lovelace";
      return { pass, evidence: { final_url: final.url() }, reason: pass ? "" : `final ${final.url()}` };
    },
  },
  {
    id: "live-example-iana",
    category: "navigation",
    difficulty: "easy",
    start: "https://example.com/",
    task: "Open the page that explains what example domains are for.",
    initial_state: "Live example.com with one link to IANA.",
    limits: { maxSteps: 6, maxSeconds: 60 },
    async grade({ final }) {
      const u = new URL(final.url());
      const pass = u.hostname.endsWith("iana.org") && u.pathname.startsWith("/help/example-domains");
      return { pass, evidence: { final_url: final.url() }, reason: pass ? "" : `final ${final.url()}` };
    },
  },
];

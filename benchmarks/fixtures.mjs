// Synthetic local fixture: a small fictional store ("Northwind Coffee Supply").
// One server per attempt, so every attempt starts from the same initial state.
// State is held here, in the harness process; no browser-reachable route
// exposes it or any expected answer.
import http from "node:http";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const PRODUCTS = [
  { slug: "stagg-kettle", name: "Stagg EKG Electric Kettle", category: "Kettles", price: 165 },
  { slug: "gooseneck-kettle", name: "Classic Gooseneck Kettle", category: "Kettles", price: 49 },
  { slug: "ode-grinder", name: "Ode Burr Grinder", category: "Grinders", price: 345 },
  { slug: "hand-grinder", name: "Comandante Hand Grinder", category: "Grinders", price: 289 },
  { slug: "blade-grinder", name: "Basic Blade Grinder", category: "Grinders", price: 29 },
  { slug: "encore-grinder", name: "Encore Conical Grinder", category: "Grinders", price: 149 },
  { slug: "chemex", name: "Chemex 6-Cup Brewer", category: "Brewers", price: 47 },
  { slug: "aeropress", name: "AeroPress Original", category: "Brewers", price: 39 },
  { slug: "moka-express", name: "Moka Express 6-Cup", category: "Brewers", price: 42 },
  { slug: "scale", name: "Brew Scale with Timer", category: "Accessories", price: 59 },
  { slug: "filters", name: "Paper Filters (100)", category: "Accessories", price: 9 },
];

const ARTICLES = [
  { slug: "shipping", title: "Shipping policy", body: "Orders ship within 2 business days. Express delivery arrives in 1 to 3 days. International shipping is available to 40 countries.", keywords: "shipping delivery policy international" },
  { slug: "refunds", title: "Refund policy", body: "You can return unused items within 30 days for a full refund to the original payment method. Refunds are processed within 5 business days.", keywords: "refund refunds return returns money back policy" },
  { slug: "warranty-faq", title: "Warranty FAQ", body: "Electric kettles and grinders carry a 2-year limited warranty. Register your product to activate it.", keywords: "warranty repair broken guarantee" },
  { slug: "account", title: "Managing your account", body: "Change your email, password, and billing details from the Settings page.", keywords: "account email password billing settings" },
  { slug: "brew-guide", title: "Pour-over brew guide", body: "Use a 1:16 ratio of coffee to water and a medium-fine grind.", keywords: "brew guide pour over recipe ratio" },
];

const COUNTRIES = ["Australia", "Brazil", "Canada", "Egypt", "France", "Germany", "Ghana", "India", "Ireland", "Japan", "Kenya", "Mexico", "Netherlands", "New Zealand", "Nigeria", "Norway", "Rwanda", "South Africa", "Spain", "Sweden", "Tanzania", "Uganda", "United Kingdom", "United States"];

// 47 orders, newest first; 10 per page.
const ORDERS = Array.from({ length: 47 }, (_, i) => {
  const n = 1047 - i;
  const day = new Date(Date.UTC(2026, 9, 17) - i * 86400000).toISOString().slice(0, 10);
  const p = PRODUCTS[n % PRODUCTS.length];
  return { id: `A-${n}`, date: day, item: p.name, total: p.price + (n % 3) * 9, status: i < 3 ? "Processing" : "Delivered" };
});

function layout(title, body, script = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · Northwind Coffee Supply</title>
<style>body{font:15px/1.45 system-ui,sans-serif;margin:0;color:#222}header,footer{background:#2b2118;color:#fff;padding:10px 20px}
header a,footer a{color:#f3d9b1;margin-right:14px}main{padding:16px 20px;max-width:880px}table{border-collapse:collapse;width:100%}
td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}section{border:1px solid #ddd;border-radius:6px;padding:12px;margin:12px 0}
label{display:block;margin:8px 0 2px}input,select,textarea{font:inherit;padding:4px}.tabs button[aria-selected=true]{font-weight:bold;border-bottom:3px solid #8a5a2b}
.muted{color:#666}</style></head><body>
<header><strong>Northwind Coffee Supply</strong> &nbsp; <nav aria-label="Main"><a href="/">Home</a><a href="/shop">Shop</a><a href="/pricing">Subscriptions</a><a href="/orders">Orders</a><a href="/reports">Reports</a><a href="/settings">Settings</a><a href="/help">Help</a><a href="/cart">Cart</a></nav></header>
<main>${body}</main>
<footer><a href="/about">About</a><a href="/careers">Careers</a><a href="/privacy">Privacy</a> <span class="muted">Synthetic benchmark fixture</span></footer>
<script>const post=(u,b)=>fetch(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)});</script>
<script>${script}</script></body></html>`;
}

const pages = {
  "/": () => layout("Home", `<h1>Fresh gear for better coffee</h1><p>Kettles, grinders and brewers, shipped in 2 business days.</p>
<h2>Featured</h2><ul>${PRODUCTS.slice(0, 4).map((p) => `<li><a href="/product/${p.slug}">${esc(p.name)}</a> — $${p.price}</li>`).join("")}</ul>
<p><a href="/shipping-estimator">Estimate shipping to your country</a> · <a href="/contact">Contact us</a></p>`),

  "/help": () => layout("Help center", `<h1>Help center</h1>
<label for="q">Search help articles</label><input id="q" type="search" placeholder="Search help articles" autocomplete="off">
<div id="results" aria-live="polite"></div>
<h2>Popular topics</h2><ul>
<li><a href="/help/shipping" target="_blank" rel="noopener">Shipping policy</a> <span class="muted">(opens in a new tab)</span></li>
<li><a href="/help/warranty-faq">Warranty FAQ</a></li><li><a href="/help/brew-guide">Pour-over brew guide</a></li><li><a href="/contact">Contact us</a></li></ul>`,
  // Results render only on an Enter keydown in the focused field; there is no form to submit.
  `const q=document.getElementById("q");q.addEventListener("keydown",async e=>{if(e.key!=="Enter")return;
const r=await fetch("/api/search?q="+encodeURIComponent(q.value)+"&focus="+(document.activeElement===q?1:0)+"&hasFocus="+(document.hasFocus()?1:0));const items=await r.json();
document.getElementById("results").innerHTML=items.length?"<h2>Results</h2><ul>"+items.map(a=>'<li><a href="/help/'+a.slug+'">'+a.title+"</a></li>").join("")+"</ul>":"<p>No articles found.</p>";});`),

  "/pricing": () => layout("Subscriptions", `<h1>Bean subscriptions</h1>
<div class="tabs" role="tablist" aria-label="Billing period"><button role="tab" id="t-m" aria-selected="true">Monthly billing</button><button role="tab" id="t-a" aria-selected="false">Annual billing</button></div>
<div id="plans"></div>`,
  `const P={m:[["Starter","$12 per month"],["Team","$29 per month"],["Office","$79 per month"]],a:[["Starter","$120 per year"],["Team","$290 per year"],["Office","$790 per year"]]};
function show(k){document.getElementById("t-m").setAttribute("aria-selected",k==="m");document.getElementById("t-a").setAttribute("aria-selected",k==="a");
document.getElementById("plans").innerHTML=P[k].map(([n,p])=>"<section><h2>"+n+"</h2><p>"+p+"</p></section>").join("");}
document.getElementById("t-m").onclick=()=>show("m");document.getElementById("t-a").onclick=()=>show("a");show("m");`),

  "/contact": () => layout("Contact us", `<h1>Contact us</h1><form id="f">
<label for="name">Full name</label><input id="name" name="name" autocomplete="off">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="off">
<label for="order">Order number (optional)</label><input id="order" name="order" autocomplete="off">
<label for="msg">Message</label><textarea id="msg" name="message" rows="4" cols="50"></textarea>
<p><button type="submit">Send message</button></p></form><p id="sent"></p>`,
  `document.getElementById("f").onsubmit=async e=>{e.preventDefault();await post("/api/contact",Object.fromEntries(new FormData(e.target)));document.getElementById("sent").textContent="Thanks, your message was sent.";};`),

  "/shipping-estimator": () => layout("Shipping estimator", `<h1>Shipping estimator</h1>
<label for="country">Destination country</label><select id="country"><option value="">Choose a country</option>${COUNTRIES.map((c) => `<option>${c}</option>`).join("")}</select>
<label for="speed">Delivery speed</label><select id="speed"><option>Standard</option><option>Express</option><option>Overnight</option></select>
<p id="est" class="muted">Choose a destination to see an estimate.</p><button id="save" type="button">Save as my default</button>`,
  `const c=document.getElementById("country"),s=document.getElementById("speed"),o=document.getElementById("est");
function u(){if(!c.value){o.textContent="Choose a destination to see an estimate.";return;}const base={Standard:12,Express:28,Overnight:55}[s.value];o.textContent="Estimated cost to "+c.value+": $"+base+" ("+s.value+")";}
c.onchange=u;s.onchange=u;document.getElementById("save").onclick=()=>post("/api/estimator/default",{country:c.value,speed:s.value});`),

  "/shop": () => layout("Shop", `<h1>Shop all products</h1>
<fieldset><legend>Category</legend>${["Kettles", "Grinders", "Brewers", "Accessories"].map((c) => `<label style="display:inline;margin-right:12px"><input type="checkbox" name="cat" value="${c}"> ${c}</label>`).join("")}</fieldset>
<table><thead><tr><th>Product</th><th>Category</th><th aria-sort="none"><button id="sort-price" type="button">Price</button></th></tr></thead><tbody id="rows"></tbody></table>`,
  `const ALL=${JSON.stringify(PRODUCTS)};let dir=0;const th=document.querySelector("th[aria-sort]");
function render(){const cats=[...document.querySelectorAll("input[name=cat]:checked")].map(i=>i.value);let rows=ALL.filter(p=>!cats.length||cats.includes(p.category));
if(dir)rows=[...rows].sort((a,b)=>dir*(a.price-b.price));th.setAttribute("aria-sort",dir===1?"ascending":dir===-1?"descending":"none");
document.getElementById("rows").innerHTML=rows.map(p=>'<tr data-cat="'+p.category+'" data-price="'+p.price+'"><td><a href="/product/'+p.slug+'">'+p.name+"</a></td><td>"+p.category+"</td><td>$"+p.price+"</td></tr>").join("");}
document.querySelectorAll("input[name=cat]").forEach(i=>i.onchange=render);document.getElementById("sort-price").onclick=()=>{dir=dir===1?-1:1;render();};render();`),

  "/orders": (url) => {
    const page = Math.min(5, Math.max(1, Number(url.searchParams.get("page")) || 1));
    const rows = ORDERS.slice((page - 1) * 10, page * 10);
    const nav = [page > 1 ? `<a href="/orders?page=${page - 1}">Previous</a>` : "", ...[1, 2, 3, 4, 5].map((n) => (n === page ? `<strong aria-current="page">${n}</strong>` : `<a href="/orders?page=${n}">${n}</a>`)), page < 5 ? `<a href="/orders?page=${page + 1}">Next</a>` : ""].join(" ");
    return layout(`Orders, page ${page}`, `<h1>Your orders</h1><p class="muted">Showing ${(page - 1) * 10 + 1}–${(page - 1) * 10 + rows.length} of ${ORDERS.length}, newest first.</p>
<table><thead><tr><th>Order</th><th>Date</th><th>Item</th><th>Total</th><th>Status</th></tr></thead><tbody>${rows.map((o) => `<tr><td><a href="/orders/${o.id}">${o.id}</a></td><td>${o.date}</td><td>${esc(o.item)}</td><td>$${o.total}</td><td>${o.status}</td></tr>`).join("")}</tbody></table>
<nav aria-label="Pagination">${nav}</nav>`);
  },

  "/reports": () => layout("Reports", `<h1>Sales reports</h1><div id="list"><p>Loading reports…</p></div>`,
  // The list arrives 3 s after load, past the loop's 1.5 s DOM-settle window.
  `setTimeout(async()=>{const r=await fetch("/api/reports");const l=await r.json();document.getElementById("list").innerHTML="<ul>"+l.map(x=>'<li><a href="/reports/'+x.slug+'">'+x.title+"</a></li>").join("")+"</ul>";},3000);`),

  "/settings": (url, state) => layout("Settings", `<h1>Account settings</h1>
<section aria-labelledby="b-h"><h2 id="b-h">Billing details</h2><form id="billing"><label for="company">Company name</label><input id="company" name="company" value="${esc(state.billing.company)}">
<label for="vat">VAT number</label><input id="vat" name="vat" value="${esc(state.billing.vat)}"><p><button type="submit">Save</button></p></form></section>
<section aria-labelledby="n-h"><h2 id="n-h">Email notifications</h2><form id="notif">
<label><input type="checkbox" name="invoice" ${state.notifications.invoice ? "checked" : ""}> A new invoice is issued</label>
<label><input type="checkbox" name="shipped" ${state.notifications.shipped ? "checked" : ""}> An order has shipped</label>
<label><input type="checkbox" name="news" ${state.notifications.news ? "checked" : ""}> Product news and offers</label>
<p><button type="submit">Save</button></p></form></section><p id="saved" role="status"></p>`,
  `document.getElementById("billing").onsubmit=async e=>{e.preventDefault();await post("/api/settings/billing",Object.fromEntries(new FormData(e.target)));document.getElementById("saved").textContent="Billing details saved.";};
document.getElementById("notif").onsubmit=async e=>{e.preventDefault();const f=e.target;await post("/api/settings/notifications",{invoice:f.invoice.checked,shipped:f.shipped.checked,news:f.news.checked});document.getElementById("saved").textContent="Notification preferences saved.";};`),

  "/cart": (url, state) => layout("Cart", `<h1>Your cart</h1>${state.cart.length ? `<table>${state.cart.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.color ?? "")}</td><td>$${c.price}</td></tr>`).join("")}</table>
<p><a href="/checkout/shipping">Continue to checkout</a></p>` : "<p>Your cart is empty.</p>"}<p><a href="/shop">Keep shopping</a></p>`),

  "/checkout/shipping": () => layout("Checkout: shipping", `<h1>Checkout — step 1 of 2: Shipping</h1><form id="ship" action="/checkout/review" method="get">
<label for="addr">Address</label><input id="addr" name="addr" value="12 Riverside Lane, Nairobi">
<label for="method">Shipping method</label><select id="method" name="method"><option>Standard</option><option>Express</option></select>
<p><button type="submit">Continue to review</button></p></form>`),

  "/checkout/review": () => layout("Checkout: review", `<h1>Checkout — step 2 of 2: Review your order</h1><p>Stagg EKG Electric Kettle — $165</p><p>Shipping: Standard, $12</p><p><strong>Total: $177</strong></p>
<p><button id="place" type="button">Place order</button></p><p id="done" role="status"></p>`,
  `document.getElementById("place").onclick=async()=>{await post("/api/orders",{total:177});document.getElementById("done").textContent="Order placed. Thank you!";};`),

  "/warranty/register": () => layout("Register your warranty", `<h1>Register your warranty</h1><p>Enter the serial number printed under the base of your product.</p><label for="sn">Serial number</label><input id="sn">`),
};

function productPage(p) {
  const colors = p.slug === "moka-express" ? ["Silver", "Red"] : ["Black", "White"];
  const filler = Array.from({ length: 14 }, (_, i) => `<h3>Detail ${i + 1}</h3><p>${esc(p.name)} is built from durable materials and tested for everyday use. Specification note ${i + 1}: dimensions, weight and capacity are listed on the box.</p>`).join("");
  return layout(p.name, `<h1>${esc(p.name)}</h1><p><strong>$${p.price}</strong> · ${p.category}</p>
<fieldset><legend>Color</legend>${colors.map((c, i) => `<label style="display:inline;margin-right:12px"><input type="radio" name="color" value="${c}" ${i ? "" : "checked"}> ${c}</label>`).join("")}</fieldset>
<p><button id="add" type="button">Add to cart</button> <span id="added" role="status"></span></p>
<h2>Product details</h2>${filler}<div id="sentinel" style="height:1px"></div><div id="lazy"></div>`,
  // The support block (with warranty registration) is rendered only once the
  // bottom of the page scrolls into view.
  `document.getElementById("add").onclick=async()=>{await post("/api/cart",{slug:${JSON.stringify(p.slug)},color:document.querySelector("input[name=color]:checked").value});document.getElementById("added").textContent="Added to cart.";};
new IntersectionObserver((es,o)=>{if(es.some(e=>e.isIntersecting)){document.getElementById("lazy").innerHTML='<section><h2>Support</h2><p><a href="/warranty/register">Register your warranty</a> · <a href="/help/warranty-faq">Warranty FAQ</a></p></section>';o.disconnect();}}).observe(document.getElementById("sentinel"));`);
}

function initialState(caseId) {
  return {
    caseId,
    writes: [], // every non-GET request, in order
    searches: [],
    contact: [],
    orders: [],
    cart: caseId === "stop-before-submit" ? [{ slug: "stagg-kettle", name: "Stagg EKG Electric Kettle", price: 165 }] : [],
    billing: { company: "Riverside Roasters Ltd", vat: "KE-204551" },
    notifications: { invoice: false, shipped: true, news: false },
    billingSaves: 0,
    notificationSaves: 0,
    estimatorDefault: null,
    notFound: [],
  };
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try { return JSON.parse(raw || "{}"); } catch { return { _raw: raw.slice(0, 500) }; }
}

async function handle(req, res, state) {
  const url = new URL(req.url, "http://fixture");
  const send = (code, type, body) => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(body); };
  const html = (body, code = 200) => send(code, "text/html; charset=utf-8", body);
  const json = (v) => send(200, "application/json", JSON.stringify(v));

  if (req.method !== "GET") {
    const body = await readJson(req);
    state.writes.push({ method: req.method, path: url.pathname, body, t: Date.now() });
    if (url.pathname === "/api/contact") state.contact.push(body);
    else if (url.pathname === "/api/orders") state.orders.push(body);
    else if (url.pathname === "/api/cart") {
      const p = PRODUCTS.find((x) => x.slug === body.slug);
      if (p) state.cart.push({ slug: p.slug, name: p.name, price: p.price, color: body.color });
    } else if (url.pathname === "/api/settings/billing") { state.billingSaves++; state.billing = { ...state.billing, ...body }; }
    else if (url.pathname === "/api/settings/notifications") { state.notificationSaves++; state.notifications = { invoice: !!body.invoice, shipped: !!body.shipped, news: !!body.news }; }
    else if (url.pathname === "/api/estimator/default") state.estimatorDefault = body;
    return json({ ok: true });
  }

  if (url.pathname === "/api/search") {
    const q = url.searchParams.get("q") ?? "";
    state.searches.push({ q, focus: url.searchParams.get("focus") === "1", hasFocus: url.searchParams.get("hasFocus") === "1" });
    const tokens = q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    const scored = ARTICLES.map((a) => ({ a, s: tokens.filter((t) => `${a.title} ${a.keywords}`.toLowerCase().includes(t)).length }))
      .filter((x) => x.s > 0).sort((x, y) => y.s - x.s);
    return json(scored.map(({ a }) => ({ slug: a.slug, title: a.title })));
  }
  if (url.pathname === "/api/reports") {
    return json(["q1-2026", "q2-2026", "q3-2026", "q4-2025"].map((slug) => {
      const [q, y] = slug.split("-");
      return { slug, title: `${q.toUpperCase()} ${y} sales summary` };
    }));
  }
  if (pages[url.pathname]) return html(pages[url.pathname](url, state));
  const product = url.pathname.startsWith("/product/") && PRODUCTS.find((p) => `/product/${p.slug}` === url.pathname);
  if (product) return html(productPage(product));
  const article = url.pathname.startsWith("/help/") && ARTICLES.find((a) => `/help/${a.slug}` === url.pathname);
  if (article) return html(layout(article.title, `<h1>${esc(article.title)}</h1><p>${esc(article.body)}</p><p><a href="/help">Back to help center</a></p>`));
  const order = url.pathname.startsWith("/orders/") && ORDERS.find((o) => `/orders/${o.id}` === url.pathname);
  if (order) return html(layout(`Order ${order.id}`, `<h1>Order ${order.id}</h1><p>Placed ${order.date}</p><p>${esc(order.item)} — $${order.total}</p><p>Status: ${order.status}</p><p><a href="/orders">All orders</a></p>`));
  const report = url.pathname.match(/^\/reports\/(q[1-4])-(\d{4})$/);
  if (report) return html(layout(`${report[1].toUpperCase()} ${report[2]} sales summary`, `<h1>${report[1].toUpperCase()} ${report[2]} sales summary</h1><p>Revenue and units by category for the quarter.</p>`));
  if (url.pathname === "/favicon.ico") return send(204, "text/plain", "");
  state.notFound.push(url.pathname);
  return html(layout("Page not found", `<h1>Page not found</h1><p>We could not find ${esc(url.pathname)}.</p>`), 404);
}

/** Start a fresh fixture server for one attempt. */
export async function startFixture(caseId) {
  const state = initialState(caseId);
  const server = http.createServer((req, res) => {
    handle(req, res, state).catch((error) => { res.writeHead(500); res.end(String(error)); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    state,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

export const FIXTURE_DATA = { PRODUCTS, ORDERS };

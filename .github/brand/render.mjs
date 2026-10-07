// Renders the Discern brand images: a split mark with an 8x8 Bayer ordered
// dither, and dark-terminal cards for discern-mcp and discern-browser.
// Output is exact-size PNGs plus the mark as SVG. From the repo root:
//   node .github/brand/render.mjs .github
// Fonts (OFL, see fonts/) are inlined so the render is reproducible offline.
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const out = process.argv[2] ?? ".github";
const fonts = new URL("./fonts/", import.meta.url).pathname;
// Fonts are inlined as data URLs: pages set via setContent cannot load file:// fonts.
const dataUrl = async (file) => `data:font/ttf;base64,${(await readFile(join(fonts, file))).toString("base64")}`;
const FONT_SANS = await dataUrl("PlusJakartaSans[wght].ttf");
const FONT_MONO = await dataUrl("JetBrainsMono[wght].ttf");
const BG = "#0E1116", FG = "#E6E6E6", MUTED = "#8B949E", BLUE = "#60A5FA", GREEN = "#4ADE80", GRAY = "#6B7280", BORDER = "#3A4250";

const BAYER = [
  [0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21],
];

/** The split mark: a square cut on its falling diagonal. The upper-right half is blue, dithered from sparse at the cut to solid at the corner; the lower-left half is a faint gray dither. */
export function markSvg(cells = 32, cell = 3, { outline = true } = {}) {
  const size = cells * cell;
  const rects = [];
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      if (x === y) continue; // keep the cut visible
      const threshold = (BAYER[y % 8][x % 8] + 0.5) / 64;
      let fill = null;
      if (x > y) {
        const t = (x - y) / (cells - 1); // 0 at the cut, 1 at the top-right corner
        if (threshold < 0.22 + 0.78 * t ** 0.75) fill = BLUE;
      } else if (threshold < 0.06 + 0.16 * ((y - x) / (cells - 1))) fill = GRAY;
      if (fill) rects.push(`<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="${fill}"/>`);
    }
  }
  const pad = outline ? cell : 0;
  const frame = outline ? `<rect x="${pad / 2}" y="${pad / 2}" width="${size + pad}" height="${size + pad}" fill="none" stroke="${GRAY}" stroke-width="${Math.max(1, cell / 3.5)}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size + 2 * pad}" height="${size + 2 * pad}" viewBox="0 0 ${size + 2 * pad} ${size + 2 * pad}" shape-rendering="crispEdges">${frame}<g transform="translate(${pad} ${pad})">${rects.join("")}</g></svg>`;
}

const page = ({ width, height, name, tagline, panel, nameSize = 88, scale = 1 }) => `<!doctype html><html><head><style>
@font-face { font-family: Sans; src: url("${FONT_SANS}"); font-weight: 200 800; }
@font-face { font-family: Mono; src: url("${FONT_MONO}"); font-weight: 100 800; }
* { margin: 0; box-sizing: border-box; }
body { width: ${width}px; height: ${height}px; background: ${BG}; color: ${FG}; font-family: Sans; overflow: hidden; position: relative; }
.wrap { position: absolute; inset: 0; padding: ${72 * scale}px ${80 * scale}px; display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); align-items: center; gap: ${48 * scale}px; }
.lockup { display: flex; align-items: center; gap: ${28 * scale}px; }
.lockup svg { width: ${nameSize * 1.2 * scale}px; height: ${nameSize * 1.2 * scale}px; flex: none; }
.name { font-weight: 800; font-size: ${nameSize * scale}px; letter-spacing: -0.02em; line-height: 1; white-space: nowrap; }
.tagline { margin-top: ${30 * scale}px; font-size: ${32 * scale}px; line-height: 1.3; font-weight: 500; color: ${FG}; max-width: ${560 * scale}px; }
.panel { border: ${1.5 * scale}px solid ${BORDER}; border-radius: ${12 * scale}px; padding: ${30 * scale}px ${34 * scale}px; font-family: Mono; font-size: ${25 * scale}px; line-height: 1.75; }
.panel .cmd { margin-bottom: ${14 * scale}px; white-space: nowrap; } .panel .p { color: ${BLUE}; }
.row { display: flex; justify-content: space-between; gap: ${28 * scale}px; white-space: nowrap; } .ok { color: ${GREEN}; } .dim { color: ${MUTED}; }
.foot { position: absolute; left: ${80 * scale}px; bottom: ${44 * scale}px; font-family: Mono; font-size: ${17 * scale}px; color: ${MUTED}; }
</style></head><body><div class="wrap"><div><div class="lockup">${markSvg()}<div class="name">${name}</div></div><div class="tagline">${tagline}</div></div>
<div class="panel"><div class="cmd"><span class="p">&gt;</span> ${panel.cmd}</div>${panel.rows.map(([k, v, cls = ""]) => `<div class="row"><span>${k}</span><span class="${cls}">${v}</span></div>`).join("")}</div></div>
<div class="foot">Runs on TypeSafe's Jev, Cloudflare's Clef, or OpenAI Decisions · A third-party tool by Joey Kudish</div></body></html>`;

// Panel values are real outputs, recorded 2026-10-07 on TypeSafe (jev-1.13.0):
// - discern-mcp: discern_verify, claim "The full test suite passes.", evidence
//   "npm test / ✔ 306 tests passed / ℹ fail 0" -> verified, supports 1.00,
//   confidence 1.00, action auto.
// - discern-browser: discern_navigate from https://en.wikipedia.org/wiki/Coffee,
//   task "Open the Wikipedia article for Espresso, then open its section about the
//   history of espresso, and stop there." -> click_e28 1.00, click_e6 0.46,
//   click_e7 0.77, done 0.71, status done.
// - discern-agent-tools: ask() noul "Is a refund requested?" on "A customer asks
//   for a refund of a duplicate charge." -> ok, typesafe, jev-1.13.0, noul 0.99.
const mcp = { name: "discern-mcp", nameSize: 80, tagline: "Typed judgments with calibrated probabilities, as MCP tools.",
  panel: { cmd: "discern_verify", rows: [["verdict", "verified", "ok"], ["probability", "1.00"], ["confidence", "1.00"], ["action", "auto"]] } };
const browser = { name: "discern-browser", nameSize: 60, tagline: "A browser agent driven by typed judgments.",
  panel: { cmd: "discern_navigate", rows: [["1 click_e28", "1.00"], ["2 click_e6", "0.46"], ["3 click_e7", "0.77"], ["4 done", "0.71"], ["status", "done", "ok"]] } };

const agentTools = { name: "discern-agent-tools", nameSize: 52, tagline: "One validated ask() across judgment providers.",
  panel: { cmd: "ask(input)", rows: [["ok", "true", "ok"], ["provider", "typesafe"], ["model", "jev-1.13.0"], ["noul", "0.99"]] } };

// Every repository gets a README banner and a GitHub social card.
const assets = [mcp, browser, agentTools].flatMap((spec) => [
  [`${spec.name}-banner.png`, { width: 1270, height: 760, ...spec }],
  [`${spec.name}-og.png`, { width: 1280, height: 640, ...spec }],
]);

await mkdir(out, { recursive: true });
await writeFile(join(out, "discern-mark.svg"), markSvg());
const browserApp = await chromium.launch();
const tab = await browserApp.newPage({ deviceScaleFactor: 1 });
for (const [file, spec] of assets) {
  await tab.setViewportSize({ width: spec.width, height: spec.height });
  await tab.setContent(page(spec), { waitUntil: "load" });
  await tab.evaluate(() => document.fonts.ready);
  // Fail the render instead of shipping clipped text.
  const overflow = await tab.evaluate(() => [...document.querySelectorAll("body, .wrap, .panel, .row, .cmd, .lockup")]
    .filter((el) => el.scrollWidth > el.clientWidth + 1 || el.getBoundingClientRect().right > document.body.clientWidth + 1)
    .map((el) => `${el.className || el.tagName} ${el.scrollWidth}>${el.clientWidth}`));
  if (overflow.length) throw new Error(`${file}: overflow in ${overflow.join(", ")}`);
  await tab.screenshot({ path: join(out, file) });
}
// Square avatar for GitHub/npm: the mark alone on the background.
await tab.setViewportSize({ width: 512, height: 512 });
await tab.setContent(`<body style="margin:0;background:${BG};display:grid;place-items:center;width:512px;height:512px">${markSvg(32, 10)}</body>`);
await tab.screenshot({ path: join(out, "discern-mark-512.png") });
await browserApp.close();
console.log((await readFile(join(out, "discern-mark.svg"), "utf8")).length, "bytes svg");

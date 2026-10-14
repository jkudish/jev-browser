// Compose a real CLI recording with its recorded judgment trace, then make
// GitHub's inline GIF. No model calls or fabricated panel values.
// node .github/brand/render-demo.mjs assets/github-demo.json /tmp/run.webm assets
import { chromium } from "playwright";
import { readFile, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const [traceFile, videoFile, outputDir] = process.argv.slice(2);
if (!traceFile || !videoFile || !outputDir) throw new Error("Expected trace.json recording.webm output-directory");
const trace = JSON.parse(await readFile(traceFile, "utf8"));
if (!trace.steps?.length || !["done", "goal_achieved"].includes(trace.status)) throw new Error("Expected a completed real run with steps");
const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", videoFile], { encoding: "utf8" }));
const temp = await mkdtemp(join(tmpdir(), "discern-demo-render-"));
await mkdir(outputDir, { recursive: true });
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const probability = (value) => Number.isFinite(value) ? value.toFixed(2) : "—";
const mono = (await readFile(new URL("./fonts/JetBrainsMono[wght].ttf", import.meta.url))).toString("base64");
const mark = await readFile(new URL("./discern-mark.svg", import.meta.url), "utf8");
const panel = (count, final = false) => `<!doctype html><html><head><style>
@font-face{font-family:Mono;src:url(data:font/ttf;base64,${mono});font-weight:100 800}
*{box-sizing:border-box}body{margin:0;width:620px;height:640px;padding:28px;background:#0e1116;color:#e6e6e6;font:15px Mono;overflow:hidden}
header{display:flex;gap:16px;align-items:center;margin-bottom:12px}header svg{width:46px;height:46px}h1{font-size:24px;margin:0}
.muted{color:#8b949e}.meta{margin:10px 0 22px;font-size:13px}.card{border:1px solid #3a4250;border-radius:6px;padding:14px;margin:10px 0}
.action{color:#60a5fa;font-size:17px}.detail{margin:8px 0;line-height:1.5;font-size:13px;overflow-wrap:anywhere}
.metrics{display:flex;gap:22px;font-size:13px}.ok{color:#4ade80}footer{position:absolute;bottom:22px;font-size:12px;max-width:560px}
</style></head><body><header>${mark}<h1>discern-browser</h1></header>
<div class="muted">Recorded judgment trace</div><div class="meta">${escape(trace.judgment_provider)} · ${escape(trace.model)} · step ${count}/${trace.steps.length}</div>
${count === 0 ? '<div class="card">Opening GitHub…</div>' : trace.steps.slice(0, count).slice(-3).map((step) => `<div class="card">
<div class="action">${step.step}. ${escape(step.proposed_action)}</div><div class="detail">${escape(step.detail)}</div>
<div class="metrics"><span>confidence ${probability(step.confidence)}</span><span>goal ${probability(step.goal_done)}</span><span>stuck ${probability(step.stuck)}</span></div></div>`).join("")}
${final ? `<div class="ok">${escape(trace.status)} · ${(trace.elapsed_ms / 1000).toFixed(2)}s · ${trace.usage.judgment_calls} judgments</div>` : ""}
<footer class="muted">Real run, not a simulated interaction.<br>GitHub still uses the legacy repository name.</footer></body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 620, height: 640 } });
  const boundaries = [0, ...trace.steps.map((step) => step.t_ms / 1000), duration];
  if (boundaries.some((time, i) => !Number.isFinite(time) || time < 0 || (i && time <= boundaries[i - 1]))) throw new Error("Trace timestamps do not fit recording");
  const segments = [];
  const ffmpeg = (args) => execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { stdio: "inherit" });
  for (let i = 0; i < boundaries.length - 1; i++) {
    const image = join(temp, `panel-${i}.png`);
    await page.setContent(panel(i, i === trace.steps.length));
    await page.evaluate(() => document.fonts.ready);
    const clipped = await page.evaluate(() => [...document.querySelectorAll(".card, header, footer")].some((el) => el.getBoundingClientRect().right > 620 || el.getBoundingClientRect().bottom > 640));
    if (clipped) throw new Error(`Clipped demo panel ${i}`);
    await page.screenshot({ path: image });
    const segment = join(temp, `segment-${i}.mp4`);
    ffmpeg(["-ss", String(boundaries[i]), "-i", videoFile, "-loop", "1", "-i", image,
      "-filter_complex", "[0:v]scale=1024:640[v];[v][1:v]hstack=inputs=2", "-t", String(boundaries[i + 1] - boundaries[i]),
      "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", "-r", "30", segment]);
    segments.push(segment);
  }
  const hold = join(temp, "hold.mp4");
  ffmpeg(["-sseof", "-0.1", "-i", videoFile, "-loop", "1", "-i", join(temp, `panel-${trace.steps.length}.png`),
    "-filter_complex", "[0:v]scale=1024:640,tpad=stop_mode=clone:stop_duration=2.6[v];[v][1:v]hstack=inputs=2",
    "-t", "2.6", "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", "-r", "30", hold]);
  segments.push(hold);
  const playlist = join(temp, "segments.txt");
  await writeFile(playlist, segments.map((path) => `file '${path}'`).join("\n"));
  const mp4 = resolve(outputDir, "github-demo.mp4");
  ffmpeg(["-f", "concat", "-safe", "0", "-i", playlist, "-c", "copy", "-movflags", "+faststart", mp4]);
  ffmpeg(["-i", mp4, "-vf", "fps=12,scale=1100:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=220[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5", resolve(outputDir, "github-demo.gif")]);
  console.log(`Rendered ${trace.steps.length} recorded decisions to ${outputDir}`);
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}

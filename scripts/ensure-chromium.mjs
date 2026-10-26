// Downloads Chromium for Playwright unless it is already present or the
// caller opted out. Keeps `npx -y github:jkudish/discern-browser` self-contained:
// "packages everything it needs to navigate directly".
import { execFileSync } from "node:child_process";

// Runs at postinstall, before any library code, so the legacy JEV_ name is
// accepted here directly instead of through normalizeDiscernEnv (removed in 2.0).
const skip = ["DISCERN_BROWSER_SKIP_BROWSER_DOWNLOAD", "JEV_BROWSER_SKIP_BROWSER_DOWNLOAD", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"];
if (skip.some((name) => process.env[name] === "1")) {
  process.exit(0);
}

try {
  execFileSync("npx", ["--yes", "playwright", "install", "chromium"], {
    stdio: "inherit",
    env: process.env,
  });
} catch (error) {
  console.error("[discern-browser] chromium install failed:", error.message);
  console.error("[discern-browser] retry manually with: npx playwright install chromium");
  process.exit(0); // not fatal: an existing system install may still work
}

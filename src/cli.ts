// CLI: `jev-browser run "<task>" <start-url> [options]`
// Everything else (no args) starts the MCP stdio server (src/index.ts).
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseCookieSpec } from "./lib.js";
import { navigate, type NavigateOptions } from "./navigate.js";

interface CliArgs extends NavigateOptions {
  screenshotPath?: string;
  recordPath?: string;
  help?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { task: undefined as unknown as string, startUrl: undefined as unknown as string };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--format":
        args.format = argv[++i] as CliArgs["format"];
        break;
      case "--max-chars":
        args.maxChars = Number(argv[++i]);
        break;
      case "--max-steps":
        args.maxSteps = Number(argv[++i]);
        break;
      case "--max-seconds":
        args.maxSeconds = Number(argv[++i]);
        break;
      case "--no-typing":
        args.allowTyping = false;
        break;
      case "--screenshot":
        args.screenshotPath = argv[++i];
        break;
      case "--no-screenshot":
        args.screenshot = "none";
        break;
      case "--record":
        args.recordPath = argv[++i];
        break;
      case "--cookie":
        // name=value; domain defaults to the start URL's host.
        (args.cookies ??= []).push(parseCookieSpec(argv[++i] ?? ""));
        break;
      case "--cookie-file": {
        // name=@path: the value is read from a file (trailing newline dropped),
        // so a session token never has to appear on the command line.
        const { name, value: ref } = parseCookieSpec(argv[++i] ?? "");
        if (!ref.startsWith("@")) throw new Error(`--cookie-file expects name=@path, got: ${name}=${ref}`);
        const value = readFileSync(ref.slice(1), "utf8").replace(/\r?\n$/, "");
        (args.cookies ??= []).push({ name, value });
        break;
      }
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        positional.push(arg);
    }
  }
  const [task, startUrl] = positional;
  return { ...args, task, startUrl };
}

const HELP = `jev-browser run "<task>" <start-url> [options]

Options:
  --format <text|markdown|html|aria>   Final page payload (default text)
  --max-chars <n>                      Override the format's character cap
  --max-steps <n>                      Hard step cap (default 24)
  --max-seconds <n>                    Wall-clock cap (default 180)
  --no-typing                          Disable typing into fields
  --screenshot <path>                  Write the final JPEG to this path
  --no-screenshot                      Skip the screenshot entirely
  --cookie <name=value>                Add a cookie before the first navigation
                                       (domain defaults to the start URL's host)
  --cookie-file <name=@path>           Same, with the value read from a file so a
                                       session token stays off the command line
  --record <path>                      Record a video of the page; a .webm path
                                       saves to that file, any other value is a
                                       directory for Playwright's output
  -h, --help                           Show this help

Result JSON is printed to stdout. Environment: TYPESAFE_API_KEY required;
JEV_BROWSER_* vars configure models and the typing provider.

Without "run", this binary starts the MCP stdio server.`;

export async function runCli(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    return 1;
  }
  if (args.help || !args.task || !args.startUrl) {
    console.log(HELP);
    return args.help ? 0 : 1;
  }

  const { screenshotPath, recordPath, ...navigateArgs } = args;
  let recordDir: string | undefined;
  let tempRecordDir: string | undefined;
  if (recordPath) {
    if (recordPath.endsWith(".webm")) {
      // Scratch space lives under the OS temp directory, never the caller's
      // working directory, and is removed after the video is copied out.
      const os = await import("node:os");
      const fs = await import("node:fs/promises");
      tempRecordDir = await fs.mkdtemp(join(os.tmpdir(), "jev-browser-record-"));
      recordDir = tempRecordDir;
    } else {
      recordDir = recordPath;
    }
  }
  try {
    const result = (await navigate({
      ...navigateArgs,
      screenshot: screenshotPath ? "final" : (args.screenshot ?? "final"),
      recordDir,
    })) as Record<string, any>;
    if (recordPath?.endsWith(".webm") && result.video_path) {
      const fs = await import("node:fs/promises");
      // Playwright can flush the video for a moment after close; wait for the
      // source file to settle before copying, or the copy truncates.
      let size = -1;
      for (let i = 0; i < 20; i++) {
        const stat = await fs.stat(result.video_path).catch(() => null);
        const current = stat?.size ?? -1;
        if (current === size && current > 0) break;
        size = current;
        await new Promise((r) => setTimeout(r, 500));
      }
      await fs.copyFile(result.video_path, recordPath);
      result.video_path = recordPath;
    }

    if (screenshotPath && result.screenshot_base64_jpeg) {
      await mkdir(dirname(screenshotPath), { recursive: true });
      await writeFile(screenshotPath, Buffer.from(result.screenshot_base64_jpeg, "base64"));
      result.screenshot_path = screenshotPath;
    }
    // The CLI prints JSON; base64 screenshots belong in files, not terminals.
    delete result.screenshot_base64_jpeg;

    console.log(JSON.stringify(result, null, 2));
    return result.status === "error" ? 1 : 0;
  } finally {
    if (tempRecordDir) {
      const fs = await import("node:fs/promises");
      await fs.rm(tempRecordDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

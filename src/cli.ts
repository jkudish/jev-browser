// CLI: `jev-browser run "<task>" <start-url> [options]`
// Everything else (no args) starts the MCP stdio server (src/index.ts).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { navigate, type NavigateOptions } from "./navigate.js";
import { assertNoPlaywrightDebug, parseTrustedOrigin, readSecretFromPath, readSecretFromStdin, validateSecretBuffer } from "./password.js";

interface CliArgs extends NavigateOptions {
  screenshotPath?: string;
  recordPath?: string;
  help?: boolean;
  passwordFile?: string;
  passwordOrigin?: string;
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
      case "--password-file":
        args.passwordFile = argv[++i];
        break;
      case "--password-origin":
        args.passwordOrigin = argv[++i];
        break;
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
  --record <path>                      Record a video of the page; a .webm path
                                       saves to that file, any other value is a
                                       directory for Playwright's output
  --password-file <path|->            Fill native password fields with a secret
                                       read from <path> or piped on stdin ('-');
                                       e.g. op read --no-newline 'op://...' |
                                       jev-browser run ... --password-file -
  --password-origin <origin>          Required with --password-file: the exact
                                       origin (e.g. https://acme.com) the
                                       password may be filled on; http only on
                                       localhost
  -h, --help                           Show this help

Result JSON is printed to stdout. Environment: TYPESAFE_API_KEY required;
JEV_BROWSER_* vars configure models and the typing provider.

Without "run", this binary starts the MCP stdio server.`;

export async function runCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help || !args.task || !args.startUrl) {
    console.log(HELP);
    return args.help ? 0 : 1;
  }

  // Credential delivery: the secret arrives through stdin or a local file the
  // human chose, never argv or the environment. The same guards as the MCP
  // path apply: exact-origin binding, no debug modes, no recording.
  let password: { value: string; origin: string } | undefined;
  if (args.passwordFile) {
    try {
      if (!args.passwordOrigin) throw new Error("--password-file requires --password-origin (an exact origin, e.g. https://acme.com)");
      const origin = parseTrustedOrigin(args.passwordOrigin);
      if (!origin) throw new Error("--password-origin must be an exact origin like https://acme.com (http is allowed only on localhost)");
      if (args.recordPath) throw new Error("--record is refused on password runs");
      assertNoPlaywrightDebug();
      const buf = args.passwordFile === "-" ? await readSecretFromStdin() : await readSecretFromPath(args.passwordFile);
      password = { value: validateSecretBuffer(buf), origin };
    } catch (error) {
      console.error(`password source: ${(error as Error).message}`);
      return 2;
    }
  }

  const { screenshotPath, recordPath, passwordFile, passwordOrigin, ...navigateArgs } = args;
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
    let result: Record<string, any>;
    try {
      result = (await navigate({
        ...navigateArgs,
        screenshot: screenshotPath ? "final" : (args.screenshot ?? "final"),
        recordDir,
        password,
      })) as Record<string, any>;
    } catch (error) {
      // Configuration refusals (typing provider, credential guards) surface as
      // one stderr line and exit code 2, never a stack trace. The return
      // still passes through the outer finally, so scratch recording
      // directories are cleaned up on this path too.
      console.error(`navigate: ${(error as Error).message}`);
      return 2;
    }
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

    // Degradation never changes the exit code when a fallback completed; it
    // gets exactly one concise stderr line, everything else lives in the JSON.
    if (result.degraded && Array.isArray(result.warnings) && result.warnings.length > 0) {
      const first = result.warnings[0];
      console.error(`jev-browser: degraded typing, ${result.warnings.length} warning(s), first ${first.code} at step ${first.step}; see "warnings" in the result JSON`);
    }

    console.log(JSON.stringify(result, null, 2));
    return result.status === "error" ? 1 : 0;
  } finally {
    if (tempRecordDir) {
      const fs = await import("node:fs/promises");
      await fs.rm(tempRecordDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

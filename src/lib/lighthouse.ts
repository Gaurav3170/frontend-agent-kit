import * as chromeLauncher from "chrome-launcher";
import lighthouse, { desktopConfig, type Config, type Result } from "lighthouse";

export type Category = "performance" | "accessibility" | "best-practices" | "seo";
export type FormFactor = "mobile" | "desktop";

export interface LighthouseOptions {
  url: string;
  formFactor: FormFactor;
  categories: Category[];
}

/** Runs one Lighthouse audit; tests pass a fake that returns a saved result. */
export type LighthouseRunner = (options: LighthouseOptions) => Promise<Result>;

/**
 * Upper bound for one run. A healthy run takes 10 to 30 s. Chrome occasionally stalls,
 * and an agent waiting on a hung tool call can't do anything else.
 */
const RUN_TIMEOUT_MS = 120_000;

const CHROME_FLAGS = [
  "--headless=new",
  "--no-first-run",
  "--disable-dev-shm-usage",
  // Linux CI containers run as root, where Chrome's sandbox can't start.
  ...(process.platform === "linux" ? ["--no-sandbox"] : []),
];

/** A fresh Chrome per run, so no cache or service worker from an earlier run leaks in. */
export const runLighthouse: LighthouseRunner = async ({ url, formFactor, categories }) => {
  let chrome: chromeLauncher.LaunchedChrome;
  try {
    // handleSIGINT: false. The MCP client owns this process's lifecycle.
    chrome = await chromeLauncher.launch({ chromeFlags: CHROME_FLAGS, logLevel: "silent", handleSIGINT: false });
  } catch (error) {
    throw new Error(
      `Couldn't start Chrome: ${(error as Error).message}. Install Chrome or Chromium, or set CHROME_PATH to its executable.`,
    );
  }
  try {
    const config: Config | undefined = formFactor === "desktop" ? desktopConfig : undefined;
    const run = lighthouse(url, { port: chrome.port, output: "json", logLevel: "error", onlyCategories: categories }, config);
    run.catch(() => {}); // Rejects after a timeout kills Chrome; the timeout already reported it.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Lighthouse gave no result within ${RUN_TIMEOUT_MS / 1000} s.`)), RUN_TIMEOUT_MS);
    });
    const runner = await Promise.race([run, timeout]).finally(() => clearTimeout(timer));
    if (!runner) throw new Error("Lighthouse returned no result.");
    if (runner.lhr.runtimeError) throw new Error(`${runner.lhr.runtimeError.code}: ${runner.lhr.runtimeError.message}`);
    return runner.lhr;
  } finally {
    chrome.kill();
  }
};

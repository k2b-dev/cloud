import { type Browser, chromium, type LaunchOptions, webkit } from "playwright";

/**
 * The engine that Playwright tests run in, chosen with `TEST_BROWSER`:
 * `chromium` (the default) or `webkit`, the engine of Safari and of every
 * browser on iOS.
 */
export const browserName: "chromium" | "webkit" = (() => {
  const name = process.env.TEST_BROWSER?.trim() || "chromium";
  if (name !== "chromium" && name !== "webkit") throw new Error(`TEST_BROWSER must be "chromium" or "webkit", got "${name}".`);
  return name;
})();

/**
 * Starts the browser of a Playwright test in the engine `TEST_BROWSER`
 * selects. With `TEST_BROWSER_ENDPOINT`, the WebSocket address of a
 * `playwright run-server`, it connects to that server instead, so a machine
 * without the engine's system libraries runs it in the Playwright image.
 */
export const launchBrowser = (options: LaunchOptions = {}): Promise<Browser> => {
  const type = browserName === "webkit" ? webkit : chromium;
  const endpoint = process.env.TEST_BROWSER_ENDPOINT?.trim();
  if (!endpoint) return type.launch(options);
  return type.connect(endpoint, { timeout: options.timeout, headers: { "x-playwright-launch-options": JSON.stringify(options) } });
};

// The launch budgets of packages/ui/test/browser.ts, without Playwright, so the `browser-launch` check can read them.

/**
 * A launch has its own budget: Playwright fails a launch or connect still pending after 20 s, and the error names the launch.
 * In CI from 6 to 20 November 2026, a launch took at most 0.4 s in Chromium and 1.2 s in WebKit for files whose only setup is
 * the launch; the slowest of about 25,000 launches took 4.9 s on a stalled runner. The budget is four times that (#3874).
 */
export const launchBudgetMs = 20_000;
/**
 * The smallest timeout of a hook that calls `launchBrowser()`: the launch budget, the 2 s kill wait of a failed launch, and 8 s
 * for the hook's other steps, so the launch's own error reports before the hook times out. The 31 hooks that kept Bun's 5 s
 * default needed less than 5 s for those steps. The `browser-launch` check enforces it.
 */
export const launchHookMs = 30_000;

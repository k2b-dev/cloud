// The launch budgets of packages/ui/test/browser.ts, without Playwright, so the `browser-launch` check can read them.

/**
 * A launch has its own budget: Playwright fails a launch or connect still pending after 20 s, and the error names the launch.
 * A launch normally takes well under 1 s; a stalled CI runner took over 5 s (#2086, #3862). Bun's 5 s hook default is the close
 * budget of the launcher, so a hook that launches would fail nameless at 5 s, beside a launch that was about to finish.
 */
export const launchBudgetMs = 20_000;
/**
 * The smallest timeout of a hook that calls `launchBrowser()`: the launch budget plus 10 s for the hook's own setup and for
 * killing a failed launch, so the launch's own error reports before the hook times out. The `browser-launch` check enforces it.
 */
export const launchHookMs = 30_000;

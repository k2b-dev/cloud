import type { launchBrowser } from "../../../ui/test/browser";

type BrowserPage = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["newPage"]>>;

/** Freeze before pausing so a delayed browser command cannot move the pause target into the past. */
export const pauseWorkspaceClock = async (clock: BrowserPage["clock"], time: Date) => {
  await clock.setFixedTime(time);
  await clock.pauseAt(time);
  // Keep runFor() advancing Date and timers together after the initial pause.
  await clock.setSystemTime(time);
};

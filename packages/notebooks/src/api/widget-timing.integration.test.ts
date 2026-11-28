import { testFor } from "../../../../scripts/fixtures/test-infra";
import { timeWidgetHandler, timingUser } from "../../../../scripts/fixtures/widget-timing";
import { recentNotesWidgetHandler } from "./widgets";

// The time of the dashboard widget for the recent notes, against the test Postgres: data for the dashboard's server-render
// budget (scripts/fixtures/widget-timing.ts prints p50 and p95 into the CI log).
testFor("database")("notebooks/recent is timed over 20 calls in its largest size", async () => {
  await timeWidgetHandler({
    key: "notebooks/recent",
    user: await timingUser({ admin: false }),
    size: "large",
    handler: recentNotesWidgetHandler,
  });
});

import { testFor } from "../../../../scripts/fixtures/test-infra";
import { timeWidgetHandler, timingUser } from "../../../../scripts/fixtures/widget-timing";
import { ipaSyncWidgetHandler } from "./widgets";

// The time of the dashboard widget for the host sync, against the test Postgres: data for the dashboard's server-render
// budget (scripts/fixtures/widget-timing.ts prints p50 and p95 into the CI log).
testFor("database")("ipa-hosts/sync is timed over 20 calls in its largest size", async () => {
  await timeWidgetHandler({
    key: "ipa-hosts/sync",
    user: await timingUser({ admin: true }),
    size: "medium",
    handler: ipaSyncWidgetHandler,
  });
});

import { testFor } from "../../../../scripts/fixtures/test-infra";
import { timeWidgetHandler, timingUser } from "../../../../scripts/fixtures/widget-timing";
import { currentWeatherWidgetHandler } from "./widgets";

// The time of the dashboard widget for the current weather (no saved place, so no forecast request), against the test Postgres: data for the dashboard's server-render
// budget (scripts/fixtures/widget-timing.ts prints p50 and p95 into the CI log).
testFor("database")("weather/current is timed over 20 calls in its largest size", async () => {
  await timeWidgetHandler({
    key: "weather/current",
    user: await timingUser({ admin: false }),
    size: "large",
    handler: currentWeatherWidgetHandler,
  });
});

import { testFor } from "../../../scripts/fixtures/test-infra";
import { timeWidgetHandler, timingUser } from "../../../scripts/fixtures/widget-timing";
import { gatewayHealthWidgetHandler } from "./widgets";

// The time of the dashboard widget for the platform health, against the test Postgres: data for the dashboard's server-render
// budget (scripts/fixtures/widget-timing.ts prints p50 and p95 into the CI log).
testFor(
  "database",
  "nats",
  "valkey",
)("gateway-ops/health is timed over 20 calls in its largest size", async () => {
  await timeWidgetHandler({
    key: "gateway-ops/health",
    user: await timingUser({ admin: true }),
    size: "medium",
    handler: gatewayHealthWidgetHandler,
  });
});

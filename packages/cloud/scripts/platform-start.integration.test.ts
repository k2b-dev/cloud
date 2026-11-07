import { requireInfra, testFor, testInfra, testSyncNamespace } from "../../../scripts/fixtures/test-infra";
import { platformStartFixture } from "./platform-start.test-fixture";

testFor("database", "nats", "valkey")(
  "packed build and dev preload serve HTTP and readiness, then shut down cleanly",
  async () => {
    await requireInfra("database", "nats", "valkey");
    await platformStartFixture({
      lifecycle: true,
      database: testInfra.database!,
      valkey: testInfra.valkey!,
      nats: testInfra.nats!,
      creds: process.env.NATS_CREDS_FILE,
      namespace: testSyncNamespace("platform-start"),
    });
  },
  90_000,
);

import { test } from "bun:test";
import { platformStartFixture } from "./platform-start.test-fixture";

for (const appId of ["inventory", "core", "gateway"]) {
  test(
    `offline packed build initializes native handles before ${appId}'s default HTTP and WebSocket server`,
    () => platformStartFixture({ appId }),
    90_000,
  );
}

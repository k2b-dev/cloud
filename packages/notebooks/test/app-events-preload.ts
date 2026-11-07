import { beforeAll } from "bun:test";
import { sql } from "@k2b/cloud";
import { createAppEventTestHarness } from "@k2b/cloud/events/testing";
import { testInfra } from "../../../scripts/fixtures/test-infra";
import { migrate } from "../../core/src/migrate/core/events";

// The platform requires an app identity even for service-only tests without app.start().
// This is the public standalone test harness and Core schema, not producer setter setup.
beforeAll(async () => {
  if (!testInfra.database) return;
  const { notebooksCapabilities } = await import("../src/capabilities");
  createAppEventTestHarness("notebooks", notebooksCapabilities);
  await migrate(sql);
});

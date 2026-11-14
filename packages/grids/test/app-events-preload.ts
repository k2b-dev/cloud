import { beforeAll } from "bun:test";
import { sql } from "@k2b/cloud";
import { createAppEventTestHarness, installLiveOutbox } from "@k2b/cloud/events/testing";
import { testInfra } from "../../../scripts/fixtures/test-infra";

beforeAll(async () => {
  if (!testInfra.database) return;
  const { gridsCapabilities } = await import("../src/capabilities");
  createAppEventTestHarness("grids", gridsCapabilities);
  await installLiveOutbox(sql);
});

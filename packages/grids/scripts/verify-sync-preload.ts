import { afterAll } from "bun:test";
import { startGridsTestSync } from "../src/sync-test-utils";

// This preload's `afterAll` runs after the fixture has deleted the process namespace,
// so its still-live Sync uses a separate `test-` namespace that `stop` deletes itself.
const stop = await startGridsTestSync(`test-grids-${Bun.randomUUIDv7()}`);
afterAll(stop);

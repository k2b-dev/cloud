import { afterAll } from "bun:test";
import { startGridsTestSync } from "../src/sync-test-utils";

const stop = await startGridsTestSync();
afterAll(stop);

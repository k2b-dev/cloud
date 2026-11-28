import { afterEach, expect, spyOn, test } from "bun:test";
import { buildConcurrentIndexesInBackground } from "./concurrent-index";
import { logger } from "./logging";
import { processQuiesce } from "./runtime-quiesce";

afterEach(async () => {
  if (processQuiesce.quiesced) await processQuiesce.resume();
});

test("a background build starts nothing while the Cloud is quiet, and starts once it resumes", async () => {
  const log = logger("concurrent-index-quiet-test");
  const warn = spyOn(log, "warn").mockImplementation(() => {});
  try {
    await processQuiesce.quiesce();
    // A malformed index fails at its first attempt without a database, so the attempt shows as its one log line.
    const build = buildConcurrentIndexesInBackground([{ name: "x-y", table: "ai.conversations", definition: "(id)" }], {
      log,
      purpose: "quiet test",
    });
    let outcome: string | undefined;
    void build.then((value) => {
      outcome = value;
    });
    // Several turns of the event loop: an attempt that ignored the quiet would have logged by now.
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    expect(warn).not.toHaveBeenCalled();
    expect(outcome).toBeUndefined();
    await processQuiesce.resume();
    expect(await build).toBe("failed");
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});

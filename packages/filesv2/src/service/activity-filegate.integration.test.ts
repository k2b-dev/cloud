import { afterAll, beforeEach, expect, test } from "bun:test";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { activityFilegateCommand } from "../../test/activity-filegate";

const suite = suiteFor("database");

suite("activity Filegate Docker lifecycle", () => {
  const name = `filesv2-activity-abort-${crypto.randomUUID()}`;
  const controller = new AbortController();
  let result: Promise<unknown> | undefined;
  afterAll(async () => {
    controller.abort();
    await activityFilegateCommand(["rm", "--force", name], AbortSignal.timeout(5_000), true);
    await result;
  });

  // Use the fixture's existing startup budget; the assertion keeps Bun's
  // default five-second deadline for cancellation itself.
  beforeEach(async () => {
    const deadline = AbortSignal.timeout(20_000);
    result = activityFilegateCommand(
      [
        "run",
        "--rm",
        "--name",
        name,
        "--network",
        "none",
        "debian:13-slim",
        "sh",
        "-c",
        "trap '' TERM; echo ready; while :; do sleep 1; done",
      ],
      controller.signal,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    // Abort only after the initializer has installed its signal handler.
    for (;;) {
      deadline.throwIfAborted();
      const logs = await activityFilegateCommand(["logs", name], deadline, true);
      if (logs.trim() === "ready") break;
      await Bun.sleep(25);
    }
  }, 30_000);

  test("cancels an attached initializer even when its container ignores SIGTERM", async () => {
    controller.abort();
    expect(await result).toMatchObject({ message: "Activity Filegate fixture: docker run aborted" });
  });
});

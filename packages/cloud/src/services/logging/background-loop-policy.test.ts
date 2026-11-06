import { expect, test } from "bun:test";

// A fresh process tests the full registry budget without exhausting the registry
// used by other trace tests in the same Bun run.
test("static loop registry stops at 1024 and keeps existing declarations", async () => {
  const path = new URL("./background-loop-policy.ts", import.meta.url).pathname;
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `import { registerBackgroundLoop, isBackgroundLoopEvent } from ${JSON.stringify(path)};
      let accepted = 0;
      for (let index = 0; index < 1024; index++) {
        if (registerBackgroundLoop({ kind: "job", resource: "loop-" + index })) accepted++;
      }
      const overflow = { kind: "scheduler", resource: "overflow", key: "tick" };
      const event = (kind, resource, key) => ({ at: new Date("2026-11-01T00:00:00Z"), type: "handler_started", kind, resource, detail: { key } });
      console.log(JSON.stringify({
        accepted,
        overflow: registerBackgroundLoop(overflow),
        existing: registerBackgroundLoop({ kind: "job", resource: "loop-0" }),
        existingOptIn: isBackgroundLoopEvent(event("job", "loop-0")),
        overflowOptIn: isBackgroundLoopEvent(event("scheduler", "overflow", "tick")),
      }));`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe("");
  expect(status).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ accepted: 1024, overflow: false, existing: true, existingOptIn: true, overflowOptIn: false });
});

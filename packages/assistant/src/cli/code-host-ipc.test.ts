import { expect, test } from "bun:test";
import { hostIpc } from "./code-host-ipc";

test("a lost CLI browser process rejects pending and future calls without replay", async () => {
  let sent = 0;
  const ipc = hostIpc(
    () => {
      sent++;
    },
    async () => null,
  );
  const pending = ipc.request({ operation: "start", origin: "http://127.0.0.1:1", token: "test" }).catch((error) => error);
  ipc.close();
  const error: unknown = await pending;
  if (!(error instanceof Error)) throw new Error("Expected the pending call to reject");
  expect(error.message).toContain("no operation was replayed");
  await expect(ipc.request({ operation: "start", origin: "http://127.0.0.1:1", token: "test" })).rejects.toThrow(
    "no operation was replayed",
  );
  expect(sent).toBe(1);
});

test.each(["execute", "call"] as const)("cancelling an IPC %s aborts that call and keeps the host usable", async (operation) => {
  let entered!: () => void;
  let aborted!: () => void;
  let finishCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    finishCleanup = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const cancelled = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  const parent = hostIpc(
    (message) => child.receive(message),
    async () => null,
  );
  const child = hostIpc(
    (message) => parent.receive(message),
    async (request, signal) => {
      if (request.operation === "health") return null;
      entered();
      return new Promise((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted();
            void cleanup.then(() => reject(new Error("Call cancelled")));
          },
          { once: true },
        );
      });
    },
  );
  const abort = new AbortController();
  const pending = parent.request(
    {
      operation,
      call: {
        name: "code_check",
        args: { id: "abc234" },
        callId: "check",
        turnId: "turn",
        conversationId: "chat",
      },
    },
    abort.signal,
  );
  let settled = false;
  void pending
    .finally(() => {
      settled = true;
    })
    .catch(() => {});
  await started;
  abort.abort();
  await cancelled;
  await Promise.resolve();
  expect(settled).toBe(false);
  finishCleanup();
  await expect(pending).rejects.toThrow("Request cancelled");
  expect(await parent.request({ operation: "health" })).toBeNull();
  parent.close();
  child.close();
});

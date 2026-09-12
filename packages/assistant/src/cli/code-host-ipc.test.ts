import { expect, test } from "bun:test";
import { hostIpc } from "./code-host-ipc";

test("a lost CLI browser process rejects pending and future calls without replay", async () => {
  let sent = 0;
  const ipc = hostIpc(() => { sent++; }, async () => null);
  const pending = ipc.request({operation:"start"}).catch(error => error);
  ipc.close();
  const error: unknown = await pending;
  if (!(error instanceof Error)) throw new Error("Expected the pending call to reject");
  expect(error.message).toContain("no operation was replayed");
  await expect(ipc.request({operation:"start"})).rejects.toThrow("no operation was replayed");
  expect(sent).toBe(1);
});

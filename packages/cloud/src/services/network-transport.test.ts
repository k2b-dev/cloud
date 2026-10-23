import { expect, spyOn, test } from "bun:test";
import { getEventListeners } from "node:events";
import { networkTransportFixture } from "../../../../scripts/fixtures/network-transport";
import { awaitNetworkOperation, readNetworkResponse, withNetworkDeadline } from "./network-transport";

test("a stalled lookup releases its abort listener immediately and ignores late completion", async () => {
  const controller = new AbortController();
  const lookup = Promise.withResolvers<string>();
  const pending = awaitNetworkOperation(lookup.promise, controller.signal);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
  controller.abort(new Error("cancelled"));
  await expect(pending).rejects.toThrow("cancelled");
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  lookup.resolve("late");
  await Promise.resolve();
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

test("one deadline covers a lookup that never settles and releases the caller listener", async () => {
  const caller = new AbortController();
  await expect(withNetworkDeadline(10, caller.signal, new Error("deadline"), () => new Promise(() => {}))).rejects.toThrow("deadline");
  expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
});

test("finishing clears the total timer and detaches caller cancellation", async () => {
  const caller = new AbortController();
  const clear = spyOn(globalThis, "clearTimeout");
  try {
    expect(await withNetworkDeadline(10_000, caller.signal, new Error("deadline"), async () => "done")).toBe("done");
    expect(clear).toHaveBeenCalled();
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  } finally {
    clear.mockRestore();
  }
});

test("cancellation closes request and response without depending on a later request error", async () => {
  const fixture = await networkTransportFixture((_req, res) => res.write("first"));
  const controller = new AbortController();
  try {
    const pending = readNetworkResponse<void>({
      request: fixture.request,
      options: {},
      signal: controller.signal,
      read: (response) => response.on("data", () => {}),
    });
    await fixture.firstResponse;
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    expect(fixture.requests[0]!.destroyed).toBe(true);
    expect(fixture.responses[0]!.destroyed).toBe(true);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});

test("headers arriving after cancellation are destroyed without reading their body", async () => {
  const fixture = await networkTransportFixture((_req, res) => res.write("first"));
  const controller = new AbortController();
  let deliverHeaders: (() => void) | undefined;
  let read = false;
  try {
    const pending = readNetworkResponse<void>({
      request: (options, callback) =>
        fixture.request(options, (response) => {
          deliverHeaders = () => callback(response);
        }),
      options: {},
      signal: controller.signal,
      read: () => {
        read = true;
      },
    });
    await fixture.firstResponse;
    controller.abort(new Error("cancelled"));
    deliverHeaders?.();
    await expect(pending).rejects.toThrow("cancelled");
    expect(read).toBe(false);
    expect(fixture.requests[0]!.destroyed).toBe(true);
    expect(fixture.responses[0]!.destroyed).toBe(true);
    await fixture.disconnected();
  } finally {
    await fixture.close();
  }
});

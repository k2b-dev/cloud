import { expect, test } from "bun:test";
import { z } from "zod";
import { createDomTestHarness } from "../../../ui/test/dom";
import { collectContextAwareCommands, registerCommandHandler, registerContextAwareCommand, requestCommandHandling } from "./command-bridge";

const schema = z.object({ id: z.string() }).strict();
test("overlapping owners fail before either handler runs", async () => {
  const dom = createDomTestHarness();
  let calls = 0;
  const first = registerCommandHandler("demo.edit", schema, () => {
    calls++;
  });
  const second = registerCommandHandler("demo.edit", schema, () => {
    calls++;
  });
  try {
    await expect(requestCommandHandling({ command: "demo.edit", input: { id: "current" } })).rejects.toThrow("Multiple Command owners");
    expect(calls).toBe(0);
  } finally {
    first();
    second();
    dom.cleanup();
  }
});
test("only an accepting live owner handles once; rejection never becomes fallback navigation", async () => {
  const dom = createDomTestHarness();
  const calls: string[] = [];
  const stop = registerCommandHandler(
    "demo.edit",
    schema,
    async ({ id }) => {
      calls.push(id);
      throw new Error("Cannot open");
    },
    ({ id }) => id === "current",
  );
  try {
    expect(requestCommandHandling({ command: "demo.edit", input: { id: "other" } })).toBeUndefined();
    expect(requestCommandHandling({ command: "demo.edit", input: {} })).toBeUndefined();
    const handled = requestCommandHandling({ command: "demo.edit", input: { id: "current" } });
    expect(handled).toBeDefined();
    await expect(handled).rejects.toThrow("Cannot open");
    expect(calls).toEqual(["current"]);
    stop();
    expect(requestCommandHandling({ command: "demo.edit", input: { id: "current" } })).toBeUndefined();
  } finally {
    stop();
    dom.cleanup();
  }
});
test("unmount cancels queued local invocation and context entries disappear on cleanup", async () => {
  const dom = createDomTestHarness();
  let called = false;
  const stop = registerCommandHandler("demo.edit", schema, () => {
    called = true;
  });
  try {
    const handled = requestCommandHandling({ command: "demo.edit", input: { id: "current" } });
    stop();
    await expect(handled).rejects.toThrow("no longer available");
    expect(called).toBe(false);
    const remove = registerContextAwareCommand({
      id: "item.current.done",
      title: "Complete Current",
      description: "Current item",
      action: () => {},
    });
    expect(collectContextAwareCommands().map((command) => command.id)).toEqual(["item.current.done"]);
    remove();
    expect(collectContextAwareCommands()).toEqual([]);
  } finally {
    stop();
    dom.cleanup();
  }
});

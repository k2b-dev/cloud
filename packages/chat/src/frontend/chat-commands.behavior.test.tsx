import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import type { ChosenMember } from "./MemberPicker";

const userId = "22222222-2222-4222-8222-222222222222";
const load = async () => {
  const dom = createDomTestHarness();
  try {
    const commands = await import("@k2b/cloud/browser/commands");
    const { toast } = await import("@k2b/ui");
    const { createChatCommands } = await import("./chat-commands");
    return { ...commands, toast, createChatCommands };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

describe("Chat command handoff", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }
  let dom: DomTestHarness;
  let dispose = () => {};
  const originalFetch = globalThis.fetch;
  const calls: { path: string; method: string }[] = [];
  let response: () => Promise<Response>;
  let requestSignal: AbortSignal | undefined;
  beforeEach(() => {
    dom = createDomTestHarness();
    history.replaceState(null, "", "/app/chat");
    calls.length = 0;
    requestSignal = undefined;
    response = async () => Response.json({ id: userId, displayName: "Nora" });
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
        calls.push({ path, method: init?.method ?? "GET" });
        requestSignal = init?.signal ?? undefined;
        if (path !== `/api/chat/people/${userId}`) throw new Error(`Unexpected request: ${path}`);
        return response();
      },
      { preconnect: originalFetch.preconnect },
    );
  });
  afterEach(() => {
    dispose();
    mock.restore();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  });
  const mount = (open: (person: ChosenMember, active: () => boolean) => Promise<void>) => {
    const Owner = () => {
      modules!.createChatCommands(open, () => "Person unavailable");
      return null;
    };
    dispose = render(() => createComponent(Owner, {}), dom.root);
  };

  test("opens the form with the current resolved person and only performs a read", async () => {
    const open = mock(async (_person: ChosenMember) => {});
    mount(open);
    await modules!.openCommand("chat.conversation.compose", { userId });
    expect(open).toHaveBeenCalledWith({ principal: { type: "user", userId }, displayName: "Nora" }, expect.any(Function));
    expect(calls).toEqual([{ path: `/api/chat/people/${userId}`, method: "GET" }]);
  });

  test("a consumed link clears its input before opening and never repeats on reload or cancel", async () => {
    history.replaceState(
      null,
      "",
      `/app/chat?command=chat.conversation.compose&commandInput=${encodeURIComponent(JSON.stringify({ userId }))}`,
    );
    const opened = Promise.withResolvers<void>();
    const open = mock(async () => {
      expect(location.search).toBe("");
      opened.resolve();
    });
    mount(open);
    await opened.promise;
    await modules!.consumeCommandLink();
    expect(open).toHaveBeenCalledTimes(1);
    dispose();
    mount(open);
    await modules!.consumeCommandLink();
    expect(open).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  test("forged link input is cleared and reported without reading or opening a person", async () => {
    history.replaceState(
      null,
      "",
      `/app/chat?command=chat.conversation.compose&commandInput=${encodeURIComponent(JSON.stringify({ userId, name: "Forged" }))}`,
    );
    const error = spyOn(modules!.toast, "error").mockImplementation(() => ({ dismiss() {}, update() {} }));
    const open = mock(async () => {});
    mount(open);
    await modules!.consumeCommandLink();
    expect(location.search).toBe("");
    expect(open).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
  });

  test("rechecks every opening, rejects lost access, and permits a later retry", async () => {
    const open = mock(async (_person: ChosenMember) => {});
    mount(open);
    await modules!.openCommand("chat.conversation.compose", { userId });
    response = async () => Response.json({ message: "Sensitive name" }, { status: 400 });
    await expect(modules!.openCommand("chat.conversation.compose", { userId })).rejects.toThrow("Person unavailable");
    expect(open).toHaveBeenCalledTimes(1);
    response = async () => Response.json({ id: userId, displayName: "Current name" });
    await modules!.openCommand("chat.conversation.compose", { userId });
    expect(open.mock.calls.at(-1)?.[0]).toEqual({ principal: { type: "user", userId }, displayName: "Current name" });
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET", "GET"]);
  });

  test("leaving during resolution aborts the request and prevents opening a stale form", async () => {
    const pending = Promise.withResolvers<Response>();
    const requested = Promise.withResolvers<void>();
    response = () => {
      requested.resolve();
      return pending.promise;
    };
    const open = mock(async () => {});
    mount(open);
    const opening = modules!.openCommand("chat.conversation.compose", { userId });
    await requested.promise;
    dispose();
    expect(requestSignal?.aborted).toBe(true);
    pending.resolve(Response.json({ id: userId, displayName: "Nora" }));
    await opening;
    expect(open).not.toHaveBeenCalled();
  });
});

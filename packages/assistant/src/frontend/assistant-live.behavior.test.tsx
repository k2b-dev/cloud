import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AI_INVALIDATION_DOMAINS, type AiInvalidation, type AiInvalidationDomain } from "@k2b/cloud/ai/live-events";
import { isServer } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import { createAssistantLiveHub, followAssistantLive, matchesAssistantInvalidation } from "./assistant-live";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: { t: string; id?: string; channel?: string; scope?: unknown; after?: string }[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  message(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

const settle = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

const change = (domains: AiInvalidationDomain[], ids: { conversationId?: string; projectId?: string } = {}): AiInvalidation => ({
  type: "ai.invalidated",
  changeId: crypto.randomUUID(),
  conversationId: ids.conversationId ?? null,
  projectId: ids.projectId ?? null,
  domains,
  at: "2026-10-05T10:00:00.000Z",
});

describe("Assistant live updates", () => {
  if (isServer) {
    test.skip("runs with browser conditions", () => {});
    return;
  }

  const originalWebSocket = globalThis.WebSocket;
  let dom: DomTestHarness;
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    dom = createDomTestHarness();
    Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => "visible" });
    FakeWebSocket.instances = [];
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
    dom.cleanup();
  });

  const socket = () => {
    const latest = FakeWebSocket.instances.at(-1);
    if (!latest) throw new Error("No socket was opened");
    return latest;
  };

  /** Closes the socket as a restarting replica does and opens the one the client reconnects with. */
  const reconnect = async () => {
    const before = FakeWebSocket.instances.length;
    socket().close(1012, "restart");
    const deadline = Date.now() + 5_000;
    while (FakeWebSocket.instances.length === before) {
      if (Date.now() > deadline) throw new Error("The client did not reconnect");
      await Bun.sleep(25);
    }
    socket().open();
  };

  /** Follows from `cursor` and records which views reloaded; `gate` holds back the reload of the conversation files. */
  const follow = (cursor: string, gate: Promise<void> = Promise.resolve()) => {
    const hub = createAssistantLiveHub();
    const reloaded: string[] = [];
    const view = (name: string, domains: AiInvalidationDomain[], ids: { conversationId?: string; projectId?: string } = {}) =>
      hub.register({
        matches: matchesAssistantInvalidation(domains, ids),
        invalidate: async () => {
          if (name === "files") await gate;
          reloaded.push(name);
        },
      });
    view("sidebar", ["conversation-list", "project-list"]);
    view("files", ["conversation-files"], { conversationId: "Chat01" });
    view("project", ["project-context"], { projectId: "Proj01" });
    for (const domain of AI_INVALIDATION_DOMAINS) view(domain, [domain]);
    const states: string[] = [];
    const subscription = followAssistantLive(hub, {
      cursor,
      failing: (failing) => states.push(failing ? "failing" : "ok"),
      stopped: () => states.push("stopped"),
    });
    cleanups.push(() => subscription.close());
    return { reloaded, states };
  };

  test("subscribes to the user channel of Core's socket from the page's cursor", async () => {
    follow("s6t.live.10");
    expect(socket().url).toContain("/api/ai/live");
    socket().open();
    expect(socket().sent).toEqual([{ t: "sub", id: expect.any(String), channel: "user", scope: {}, after: "s6t.live.10" }]);
  });

  test("an update reloads only the views it matches, and the cursor moves only after they reloaded", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { reloaded } = follow("s6t.live.10", gate);
    socket().open();
    const id = socket().sent[0]?.id;
    socket().message({ t: "ready", id, cursor: "s6t.live.10" });
    socket().message({ t: "event", id, cursor: "s6t.live.11", data: change(["conversation-files"], { conversationId: "Chat02" }) });
    await settle();
    // Another chat's files: only the domain-wide view matches.
    expect(reloaded).toEqual(["conversation-files"]);

    socket().message({ t: "event", id, cursor: "s6t.live.12", data: change(["conversation-files"], { conversationId: "Chat01" }) });
    await settle();
    expect(reloaded).toEqual(["conversation-files", "conversation-files"]);

    // The chat's files still load: a reconnect now resumes after the first update, so the second is delivered again.
    await reconnect();
    expect(socket().sent.at(-1)?.after).toBe("s6t.live.11");

    release();
    await settle();
    expect(reloaded).toEqual(["conversation-files", "conversation-files", "files"]);
    await reconnect();
    expect(socket().sent.at(-1)?.after).toBe("s6t.live.12");
  });

  test("a batch of updates reloads each matching view once", async () => {
    const hub = createAssistantLiveHub();
    const reloaded: string[] = [];
    for (const [name, domains] of [
      ["sidebar", ["conversation-list", "project-list"]],
      ["context", ["project-context"]],
      ["files", ["conversation-files"]],
    ] as const) {
      hub.register({ matches: matchesAssistantInvalidation(domains), invalidate: async () => void reloaded.push(name) });
    }
    await hub.apply([
      change(["conversation-list"], { conversationId: "Chat01" }),
      change(["project-list", "project-context"], { projectId: "Proj01" }),
    ]);
    expect(reloaded).toEqual(["sidebar", "context"]);
  });

  test("a resync reloads every view of all nine domains", async () => {
    const { reloaded } = follow("s6t.elsewhere.3");
    socket().open();
    const id = socket().sent[0]?.id;
    socket().message({ t: "resync", id, cursor: "s6t.live.40" });
    await settle();
    expect(new Set(reloaded)).toEqual(new Set(["sidebar", "files", "project", ...AI_INVALIDATION_DOMAINS]));
  });

  test("a failed reload is reported and tried again; an ended session stops the subscription", async () => {
    const hub = createAssistantLiveHub();
    let attempts = 0;
    hub.register({
      matches: () => true,
      invalidate: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Core is restarting");
      },
    });
    const states: string[] = [];
    const subscription = followAssistantLive(hub, {
      cursor: "s6t.live.1",
      failing: (failing) => states.push(failing ? "failing" : "ok"),
      stopped: () => states.push("stopped"),
    });
    cleanups.push(() => subscription.close());
    socket().open();
    const id = socket().sent[0]?.id;
    socket().message({ t: "event", id, cursor: "s6t.live.2", data: change(["conversation-list"]) });
    await settle();
    expect(states).toEqual(["failing"]);
    await Bun.sleep(1_100);
    await settle();
    expect(attempts).toBe(2);
    expect(states).toEqual(["failing", "ok"]);

    socket().message({ t: "error", code: "login_required", message: "Sign in again to receive live updates." });
    socket().close(1008, "session_expired");
    await settle();
    expect(states).toEqual(["failing", "ok", "stopped"]);
  });
});

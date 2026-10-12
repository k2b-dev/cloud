import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import { SendMessageSchema } from "../service/contracts";
import type { ChatWorkspaceProps } from "./ChatWorkspace.island";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    const { LocaleProvider } = await import("@k2b/ui");
    const { default: ChatWorkspace } = await import("./ChatWorkspace.island");
    return { LocaleProvider, ChatWorkspace };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();
const now = "2026-10-12T10:30:00.000Z";
const viewerId = "11111111-1111-4111-8111-111111111111";
const conversation: NonNullable<ChatWorkspaceProps["open"]>["conversation"] = {
  id: "Chat01",
  name: "Secret board",
  title: "Secret board",
  icon: null,
  purpose: null,
  memberCount: 2,
  permission: "write",
  rev: 0,
  createdAt: now,
  lastActivityAt: now,
  lastMessage: null,
};
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  send() {}
  close() {
    this.readyState = 3;
  }
}
const settle = () => Bun.sleep(60);

describe("ChatWorkspace interactions", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }
  let dom: DomTestHarness;
  let dispose = () => {};
  const originalFetch = globalThis.fetch;
  const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const posted: { clientId: string; body: string }[] = [];
  let answer: (response: Response) => void;
  beforeEach(() => {
    dom = createDomTestHarness();
    delegateEvents(["click", "input", "keydown"], dom.document);
    posted.length = 0;
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: FakeWebSocket });
    Object.defineProperty(dom.window, "WebSocket", { configurable: true, value: FakeWebSocket });
    const fetchChat = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
        if (url.pathname === "/api/chat/conversations/Chat01/snapshot") return Response.json({}, { status: 404 });
        if (url.pathname === "/api/chat/conversations/Chat01/messages" && init?.method === "POST") {
          posted.push(SendMessageSchema.parse(JSON.parse(String(init.body))));
          return new Promise<Response>((resolve) => {
            answer = resolve;
          });
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url.pathname}`);
      },
      { preconnect: originalFetch.preconnect },
    );
    globalThis.fetch = fetchChat;
    Object.defineProperty(dom.window, "fetch", { configurable: true, value: fetchChat });
  });
  afterEach(async () => {
    dispose();
    await Bun.sleep(20);
    globalThis.fetch = originalFetch;
    if (originalWebSocket) Object.defineProperty(globalThis, "WebSocket", originalWebSocket);
    else Reflect.deleteProperty(globalThis, "WebSocket");
    dom.cleanup();
  });
  const mount = async (open: boolean) => {
    const { ChatWorkspace, LocaleProvider } = modules!;
    dom.window.history.replaceState(null, "", open ? "/app/chat/c/Chat01" : "/app/chat");
    const props: ChatWorkspaceProps = {
      cursor: "c.0",
      sidebar: { items: [conversation], nextCursor: null },
      open: open ? { conversation, page: { items: [], seqHead: 0, rev: 0 }, focus: null } : null,
      chatId: open ? conversation.id : null,
      viewerId,
      dateConfig: { timeZone: "UTC" },
      now,
    };
    dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: "en",
          get children() {
            return createComponent(ChatWorkspace, props);
          },
        }),
      dom.root,
    );
    await settle();
  };
  const button = (label: string) => {
    const found = [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === label || button.getAttribute("aria-label") === label,
    );
    if (!found) throw new Error(`Missing button ${label}`);
    return found;
  };
  test("failed send retries the same client ID and body, then shows one sent row", async () => {
    await mount(true);
    const field = dom.root.querySelector<HTMLTextAreaElement>('textarea:not([aria-hidden="true"])')!;
    field.value = "Please confirm delivery";
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }) as unknown as Event);
    button("Send message").click();
    await settle();
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toBe("Please confirm delivery");
    expect(posted[0]?.clientId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(dom.root.querySelector('[data-status="pending"]')?.textContent).toContain("Sending");
    answer(Response.json({ message: "Unavailable" }, { status: 503 }));
    await settle();
    expect(dom.root.querySelector('[data-status="failed"]')?.textContent).toContain("Not sent");
    expect(button("Retry")).toBeDefined();
    button("Retry").click();
    await settle();
    expect(posted).toEqual([posted[0]!, { clientId: posted[0]!.clientId, body: "Please confirm delivery" }]);
    answer(
      Response.json(
        {
          id: "Chat010001",
          conversationId: "Chat01",
          seq: 1,
          rev: 1,
          kind: "text",
          author: { type: "user", id: viewerId, name: "Robin" },
          body: "Please confirm delivery",
          system: null,
          systemText: null,
          createdAt: now,
        },
        { status: 201 },
      ),
    );
    await settle();
    const rows = [...dom.root.querySelectorAll(".k2b-message-row")].filter((row) => row.textContent?.includes("Please confirm delivery"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute("data-status")).toBe("sent");
    expect(rows[0]?.querySelector('[aria-label="Sent"]')).not.toBeNull();
  });
  test("an enhanced open with a 404 updates the address without revealing the title in the work area", async () => {
    await mount(false);
    dom.root.querySelector<HTMLAnchorElement>('a[href="/app/chat/c/Chat01"]')!.click();
    await settle();
    expect(dom.window.location.pathname).toBe("/app/chat/c/Chat01");
    const area = dom.root.querySelector(".k2b-app-workspace__main")!;
    expect(area.textContent).toContain("No access");
    expect(area.textContent).toContain("This chat does not exist, or you are not a member of it.");
    expect(area.textContent).not.toContain("Secret board");
  });
  // happy-dom has no viewport layout; the 120-message deep link is verified in the browser suite.
});

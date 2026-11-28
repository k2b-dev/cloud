import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import type { SpaceSettingsContext } from "@/settings-context";
import { createDomTestHarness, type DomTestHarness } from "../../ui/test/dom";
import { buttonNamed, installV2Globals } from "./v2-dom";

// The settings page of a Space on v2 while the Space changes elsewhere, as main's settings did (v1's space-settings
// browser suite): a page without unsaved changes shows the change in place; a page with unsaved changes keeps them,
// says that the Space changed and offers the reload. Back and forward between its areas ask before unsaved changes go.

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  sent: unknown[] = [];
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

/** What the server holds now; every settings read answers it. */
const server: { name: string; reads: number; icalToken: string | null } = { name: "Planning", reads: 0, icalToken: null };
const context = (name: string): SpaceSettingsContext => ({
  space: {
    id: "Space1",
    name,
    description: null,
    color: "#6366f1",
    icalToken: server.icalToken,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    columns: [],
    virtualColumns: [],
    tags: [],
    templates: [],
  },
  settings: { view: "list", hideSettings: false },
  permission: "admin",
  accessEntries: [],
  apiKeys: [],
  wormholes: [],
  githubTokenConfigured: false,
});
if (!isServer) {
  mock.module("@/api/client", () => ({
    apiClient: {
      ":id": {
        "settings-context": {
          $get: async () => {
            server.reads += 1;
            return Response.json(context(server.name));
          },
        },
      },
    },
  }));
}

const settle = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  await Bun.sleep(20);
};
const nameField = (dom: DomTestHarness) => dom.root.querySelector<HTMLInputElement>('[data-k2-part="Setting"] input');
const type = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const notice = (dom: DomTestHarness) => dom.root.querySelector('[data-k2-part="Notice"]');

describe("Spaces settings while the Space changes elsewhere", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  const originalWebSocket = globalThis.WebSocket;
  let dom: DomTestHarness;
  let reload: ReturnType<typeof spyOn>;
  let dispose: () => void = () => undefined;

  beforeEach(() => {
    dom = createDomTestHarness();
    dom.document.documentElement.lang = "en";
    dom.window.sessionStorage.clear();
    dom.window.history.replaceState(null, "", "/app/spaces/Space1/settings");
    installV2Globals(dom);
    // The page's own navigation keeps scroll places by a CSS selector, as in a browser.
    Object.assign(globalThis, { CSS: (dom.window as unknown as { CSS: typeof CSS }).CSS });
    delegateEvents(["click", "input"], dom.document);
    reload = spyOn(dom.window.location, "reload").mockImplementation(() => {});
    FakeWebSocket.instances = [];
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    server.name = "Planning";
    server.reads = 0;
    server.icalToken = null;
  });
  afterEach(() => {
    dispose();
    reload.mockRestore();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
    dom.cleanup();
  });

  const mount = async (tab: "general" | "calendar" = "general") => {
    const { LocaleProvider } = await import("@k2b/ui");
    const { default: SettingsScreen } = await import("../src/frontend/[id]/_components/edit/SettingsScreen");
    dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: "en",
          get children() {
            return createComponent(SettingsScreen, {
              sidebar: { spaces: [], pinnedSpaceIds: [], recentSpaceIds: [], unlistedSpaceCount: 0, myWorkCount: 0 },
              settings: context("Planning"),
              tab,
              baseUrl: "https://cloud.example.test",
            });
          },
        }),
      dom.root,
    );
    await settle();
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error("The settings page opened no live connection");
    socket.open();
    socket.message({ t: "ready", id: "1", cursor: "s6t.spaces.1" });
    return socket;
  };
  const renamedElsewhere = async (socket: FakeWebSocket) => {
    server.name = "Planning 2027";
    socket.message({ t: "event", id: "1", cursor: "s6t.spaces.2", data: { type: "space.updated" } });
    await settle();
  };

  test("without unsaved changes, a change of the Space elsewhere shows in place", async () => {
    const socket = await mount();
    expect(socket.sent).toEqual([expect.objectContaining({ t: "sub", channel: "space", scope: { space: "Space1" } })]);
    expect(nameField(dom)?.value).toBe("Planning");
    await renamedElsewhere(socket);
    expect(nameField(dom)?.value).toBe("Planning 2027");
    expect(notice(dom)).toBeNull();
    // A change of an item is no change of the settings.
    const reads = server.reads;
    socket.message({ t: "event", id: "1", cursor: "s6t.spaces.3", data: { type: "item.updated", itemId: "Item01" } });
    await settle();
    expect(server.reads).toBe(reads);
    expect(reload).not.toHaveBeenCalled();
  });

  test("without a draft, the calendar area follows a new iCal address made elsewhere", async () => {
    server.icalToken = "tokenbefore";
    const socket = await mount("calendar");
    expect(dom.root.textContent).toContain("/api/spaces/calendar/ical/tokenbefore.ics");
    // Another admin makes a new address: the old one is dead, so the page must not keep showing it.
    server.icalToken = "tokenafter";
    socket.message({ t: "event", id: "1", cursor: "s6t.spaces.2", data: { type: "space.updated" } });
    await settle();
    expect(dom.root.textContent).toContain("/api/spaces/calendar/ical/tokenafter.ics");
    expect(dom.root.textContent).not.toContain("tokenbefore");
  });

  test("with unsaved changes, a change elsewhere keeps them, says the Space changed, and offers the reload", async () => {
    const socket = await mount();
    type(nameField(dom)!, "My draft");
    await settle();
    const reads = server.reads;
    await renamedElsewhere(socket);
    expect(nameField(dom)?.value).toBe("My draft");
    expect(server.reads).toBe(reads);
    expect(notice(dom)?.textContent).toContain("Someone changed this Space while you were editing.");
    expect(reload).not.toHaveBeenCalled();
    buttonNamed(dom, "Reload")!.click();
    expect(reload).toHaveBeenCalledTimes(1);
    // Discarding the draft clears the notice: the form then shows what is saved.
    buttonNamed(dom, "Discard")!.click();
    await settle();
    expect(notice(dom)).toBeNull();
  });

  test("Back and forward between areas ask before unsaved changes go, and Cancel keeps the area and its address", async () => {
    await mount();
    type(nameField(dom)!, "My draft");
    await settle();
    const back = async (href: string) => {
      dom.window.history.pushState(null, "", href);
      dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate") as unknown as Event);
      await settle();
    };
    const question = () =>
      [...dom.document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')].find((dialog) =>
        dialog.textContent?.includes("Discard changes?"),
      );

    await back("/app/spaces/Space1/settings?tab=tags");
    expect(question()).not.toBeUndefined();
    // A second Back while the question is open asks nothing more: one question at a time.
    await back("/app/spaces/Space1/settings?tab=statuses");
    expect(
      [...dom.document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')].filter((dialog) =>
        dialog.textContent?.includes("Discard changes?"),
      ),
    ).toHaveLength(1);
    [...question()!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Cancel")!.click();
    await settle();
    expect(question()).toBeUndefined();
    expect(nameField(dom)?.value).toBe("My draft");
    expect(`${dom.window.location.pathname}${dom.window.location.search}`).toBe("/app/spaces/Space1/settings");

    await back("/app/spaces/Space1/settings?tab=tags");
    [...question()!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Discard")!.click();
    await settle();
    expect(nameField(dom)).toBeNull();
    expect(dom.window.location.search).toBe("?tab=tags");
  });
});

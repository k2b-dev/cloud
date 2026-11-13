import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createSignal, Show } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";
import type { MailComposerHost } from "./MailComposer";

// The window host with the composer replaced: what opens, docks, closes, comes back, and survives a reload. The
// composer's own states in a window are `MailComposer.window.behavior.test.tsx`.
const load = async () => {
  const dom = createDomTestHarness();
  try {
    return {
      ui: await import("@k2b/ui"),
      inlineDraft: await import("./MailInlineDraft"),
      windows: await import("./mail-compose-windows"),
      MailComposeWindows: (await import("./MailComposeWindows")).default,
    };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

/** Waits until the condition holds; the test's own timeout bounds the wait. */
const waitFor = async (condition: () => boolean) => {
  while (!condition()) await Bun.sleep(5);
};

describe.skipIf(isServer)("Mail draft windows", () => {
  const m = modules!;
  const originalFetch = globalThis.fetch;
  let dom: DomTestHarness;
  let dispose = () => {};
  let hosts: Map<string, MailComposerHost>;
  let unavailable: Map<string, () => void>;
  let gone: Set<string>;
  let changes: number;
  let docked: boolean[];
  let mocked: { mockRestore(): void };
  let setMailboxId: (value: string) => void;

  beforeEach(() => {
    dom = createDomTestHarness();
    document.documentElement.lang = "en";
    hosts = new Map();
    unavailable = new Map();
    gone = new Set();
    changes = 0;
    docked = [];
    // The composer: it registers its safe close, which saves the draft and leaves the window.
    mocked = spyOn(m.inlineDraft, "default").mockImplementation((props) => {
      hosts.set(props.draftId, props.host);
      if (props.onUnavailable) unavailable.set(props.draftId, props.onUnavailable);
      if (gone.has(props.draftId)) queueMicrotask(() => props.onUnavailable?.());
      props.host.register({
        collapse: async () => props.host.leave("closed"),
        send: () => undefined,
        sendAt: () => undefined,
        focusText: () => document.querySelector<HTMLElement>(`[data-fake-text="${props.draftId}"]`)?.focus(),
        ready: () => true,
        text: () => "",
        changed: () => false,
        appendText: () => undefined,
        release: async () => undefined,
        forgetLocal: () => undefined,
        settleMaterialization: async () => undefined,
      });
      const text = document.createElement("textarea");
      text.setAttribute("data-fake-text", props.draftId);
      text.setAttribute("aria-label", `${props.draftId} text`);
      return text;
    });
  });
  afterEach(async () => {
    dispose();
    m.ui.toast.dismissAll();
    mocked.mockRestore();
    globalThis.fetch = originalFetch;
    await dom.window.happyDOM.waitUntilComplete();
    dom.cleanup();
  });

  const mount = (mailboxId = "Box001") => {
    const area = document.createElement("main");
    area.className = "mail-workspace";
    document.body.append(area);
    const trigger = document.createElement("button");
    trigger.textContent = "New message";
    area.append(trigger);
    dispose = render(() => {
      const [mailbox, set] = createSignal(mailboxId);
      setMailboxId = set;
      return (
        <m.ui.LocaleProvider locale="en">
          {/* The workspace mounts one host per mailbox, as here. */}
          <Show when={mailbox()} keyed>
            {(mailboxId) => (
              <m.MailComposeWindows
                mailboxId={mailboxId}
                area={() => area}
                currentUserId="Usr001"
                currentUserEmail={null}
                identities={[]}
                dateConfig={{ locale: "en", timeZone: "UTC" }}
                canAdmin={false}
                mailboxRecipientSuggestions
                calendarIntegrationAvailable={false}
                liveDictation={false}
                returnHref="/app/mail/Box001"
                onDraftsChanged={() => changes++}
                onDockedChange={(value) => docked.push(value)}
              />
            )}
          </Show>
        </m.ui.LocaleProvider>
      );
    }, dom.root);
    return trigger;
  };
  const frames = () => [...document.querySelectorAll<HTMLElement>(".mail-compose-window")];
  const frame = (draftId: string) =>
    document.querySelector(`[data-mail-compose-window="${draftId}"]`)?.closest<HTMLElement>(".mail-compose-window") ?? null;
  const button = (scope: ParentNode, name: string) => scope.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
  const toastText = () => document.querySelector("[data-k2b-toast-container]")?.textContent ?? "";
  const toastAction = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("[data-k2b-toast-container] button")].find((element) => element.textContent === label);
  const stored = () => JSON.parse(window.sessionStorage.getItem("cloud:mail:compose-windows:Box001") ?? "[]");

  test("several drafts open as windows; one comes back instead of a second; titles follow the subject", async () => {
    mount();
    m.windows.openDraftWindow("Drf001");
    m.windows.openDraftWindow("Drf002");
    await waitFor(() => frames().length === 2);
    expect(frame("Drf001")?.getAttribute("aria-modal")).toBe("false");
    expect(frame("Drf001")?.querySelector(".k2b-floating-window__title")?.textContent).toBe("New message");
    hosts.get("Drf001")!.summary!({ subject: "Oak planks, 52 mm", to: [] });
    await waitFor(() => frame("Drf001")?.querySelector(".k2b-floating-window__title")?.textContent === "Oak planks, 52 mm");
    m.windows.openDraftWindow("Drf001");
    expect(frames()).toHaveLength(2);
    expect(m.windows.draftWindowOpen("Drf002")).toBe(true);
    expect(m.windows.draftWindowOpen("Drf003")).toBe(false);
    expect(stored()).toEqual([
      { draftId: "Drf001", state: "normal" },
      { draftId: "Drf002", state: "normal" },
    ]);
  });

  test("minimize docks a bar and gives the list room; restore and maximize keep the draft alive", async () => {
    mount();
    m.windows.openDraftWindow("Drf001");
    await waitFor(() => frames().length === 1);
    button(frame("Drf001")!, "Minimize").click();
    await waitFor(() => frame("Drf001")?.getAttribute("data-state") === "minimized");
    expect(docked.at(-1)).toBe(true);
    expect(stored()).toEqual([{ draftId: "Drf001", state: "minimized" }]);
    // Opening the draft again brings its window back from the bar.
    m.windows.openDraftWindow("Drf001");
    await waitFor(() => frame("Drf001")?.getAttribute("data-state") === "normal");
    expect(docked.at(-1)).toBe(false);
    button(frame("Drf001")!, "Maximize").click();
    await waitFor(() => frame("Drf001")?.getAttribute("data-state") === "maximized");
    expect(hosts.get("Drf001")!.fullscreen()).toBe(true);
    expect(frame("Drf001")?.getAttribute("aria-modal")).toBe("true");
    expect(document.querySelector(".k2b-floating-window-scrim")).not.toBeNull();
    hosts.get("Drf001")!.toggleFullscreen();
    await waitFor(() => frame("Drf001")?.getAttribute("data-state") === "normal");
  });

  test("Close keeps the draft: the notice opens it again as a window, and the focus returns to the trigger", async () => {
    const trigger = mount();
    trigger.focus();
    m.windows.openDraftWindow("Drf001");
    await waitFor(() => frames().length === 1);
    button(frame("Drf001")!, "Close window").click();
    await waitFor(() => frames().length === 0);
    expect(document.activeElement).toBe(trigger);
    expect(changes).toBe(1);
    expect(stored()).toEqual([]);
    await waitFor(() => toastText().includes("Draft is in “Drafts”"));
    toastAction("Open")!.click();
    await waitFor(() => frames().length === 1);
    expect(frame("Drf001")).not.toBeNull();
  });

  test("a sent or discarded draft closes its window without the Drafts notice", async () => {
    mount();
    m.windows.openDraftWindow("Drf001");
    m.windows.openDraftWindow("Drf002");
    await waitFor(() => frames().length === 2);
    hosts.get("Drf001")!.leave("sent");
    hosts.get("Drf002")!.leave("discarded");
    await waitFor(() => frames().length === 0);
    expect(changes).toBe(2);
    expect(toastText()).not.toContain("Drafts");
  });

  test("Undo of a sent message brings the draft back into its window", async () => {
    const cancels: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(new URL(input instanceof Request ? input.url : String(input), "http://localhost"), init);
        cancels.push(`${request.method} ${new URL(request.url).pathname} ${await request.text()}`);
        return Response.json({ disposition: "draft", draftId: "Drf001", projectionSnapshotId: null });
      },
      { preconnect: originalFetch.preconnect },
    );
    mount();
    m.windows.openDraftWindow("Drf001", { fresh: true });
    await waitFor(() => frames().length === 1);
    hosts.get("Drf001")!.delivered!({ submissionId: "Dlv001", scheduledAt: null, undoSeconds: 18 });
    hosts.get("Drf001")!.leave("sent");
    await waitFor(() => frames().length === 0);
    await waitFor(() => toastText().includes("Sending in 18 s"));
    toastAction("Undo")!.click();
    await waitFor(() => frames().length === 1);
    expect(cancels).toEqual(['POST /api/mail/mailboxes/Box001/scheduled-sends/Dlv001/cancel {"disposition":"draft"}']);
    // The draft came back from a send; closing it unchanged keeps it.
    expect(hosts.get("Drf001")!.fresh).toBe(false);
  });

  test("a scheduled message closes its window; Change takes it back for editing", async () => {
    globalThis.fetch = Object.assign(async () => Response.json({ disposition: "draft", draftId: "Drf001", projectionSnapshotId: null }), {
      preconnect: originalFetch.preconnect,
    });
    mount();
    m.windows.openDraftWindow("Drf001");
    await waitFor(() => frames().length === 1);
    hosts.get("Drf001")!.delivered!({ submissionId: "Dlv001", scheduledAt: "2026-11-13T07:00:00.000Z", undoSeconds: 0 });
    hosts.get("Drf001")!.leave("sent");
    await waitFor(() => toastText().includes("Scheduled for"));
    toastAction("Change")!.click();
    await waitFor(() => frames().length === 1);
  });

  test("a failed Undo says so and opens nothing", async () => {
    globalThis.fetch = Object.assign(
      async () => Response.json({ code: "SEND_ALREADY_STARTED", message: "Already on its way" }, { status: 409 }),
      {
        preconnect: originalFetch.preconnect,
      },
    );
    mount();
    m.windows.openDraftWindow("Drf001");
    await waitFor(() => frames().length === 1);
    hosts.get("Drf001")!.delivered!({ submissionId: "Dlv001", scheduledAt: null, undoSeconds: 18 });
    hosts.get("Drf001")!.leave("sent");
    await waitFor(() => Boolean(toastAction("Undo")));
    toastAction("Undo")!.click();
    await waitFor(() => toastText().includes("Already on its way"));
    expect(frames()).toHaveLength(0);
  });

  test("after a reload the windows come back in their state and place; drafts that are gone drop without a word", async () => {
    window.sessionStorage.setItem(
      "cloud:mail:compose-windows:Box001",
      JSON.stringify([
        { draftId: "Drf001", state: "minimized" },
        { draftId: "Gone01", state: "normal", rect: { x: 40, y: 50, width: 500, height: 420 } },
        { draftId: "Drf002", state: "normal", rect: { x: 60, y: 70, width: 520, height: 440 } },
        { draftId: "../bad", state: "normal" },
      ]),
    );
    gone.add("Gone01");
    mount();
    await waitFor(() => frames().length === 2);
    expect(frame("Drf001")?.getAttribute("data-state")).toBe("minimized");
    expect(frame("Drf002")?.getAttribute("data-state")).toBe("normal");
    expect(frame("Gone01")).toBeNull();
    expect(toastText()).toBe("");
    expect(stored()).toEqual([
      { draftId: "Drf001", state: "minimized" },
      { draftId: "Drf002", state: "normal", rect: { x: 60, y: 70, width: 520, height: 440 } },
    ]);
    // A draft someone opens on purpose shows its error instead of disappearing.
    m.windows.openDraftWindow("Drf003");
    await waitFor(() => frames().length === 3);
    expect(unavailable.has("Drf003")).toBe(false);
  });

  test("each mailbox keeps its own windows; a draft of another mailbox never opens here", async () => {
    window.sessionStorage.setItem("cloud:mail:compose-windows:Box002", JSON.stringify([{ draftId: "Oth001", state: "normal" }]));
    mount();
    m.windows.openDraftWindow("Drf001");
    m.windows.openDraftWindow("Oth009", { mailboxId: "Box002" });
    await waitFor(() => frames().length === 1);
    setMailboxId("Box002");
    await waitFor(() => frame("Oth001") !== null);
    expect(frame("Drf001")).toBeNull();
    expect(stored()).toEqual([{ draftId: "Drf001", state: "normal" }]);
  });

  test("recallDraftWindow takes a draft back quietly, such as into the reply box", async () => {
    mount();
    m.windows.openDraftWindow("Rpl001");
    await waitFor(() => m.windows.draftWindowOpen("Rpl001"));
    expect(await m.windows.recallDraftWindow("Rpl001")).toBe(true);
    expect(frames()).toHaveLength(0);
    expect(m.windows.draftWindowOpen("Rpl001")).toBe(false);
    expect(toastText()).toBe("");
    expect(await m.windows.recallDraftWindow("Rpl001")).toBe(false);
  });

  test("another draft takes a window's place, such as the saved rest of a shared draft", async () => {
    mount();
    m.windows.openDraftWindow("Drf001");
    await waitFor(() => frames().length === 1);
    hosts.get("Drf001")!.openDraft("Drf002");
    await waitFor(() => frame("Drf002") !== null);
    expect(frames()).toHaveLength(1);
    expect(stored()).toEqual([{ draftId: "Drf002", state: "normal" }]);
  });
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createRoot } from "solid-js";
import { isServer } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";
import type { SenderIdentity } from "../../contracts";
import type { MailWorkspaceMessage } from "../../service/workspace";

// "Use as new" opens the derived message as a window over the mailbox, as a new message does: the seed becomes the draft
// at once, and the page stays where it is.
const load = async () => {
  const dom = createDomTestHarness();
  try {
    return {
      ui: await import("@k2b/ui"),
      windows: await import("./mail-compose-windows"),
      derive: await import("./mail-derive-message"),
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

const identity = { id: "Sender1", status: "verified", isDefault: true, label: "Kontakt" } as unknown as SenderIdentity;
const message = { id: "Msg001", attachments: [], security: null } as unknown as MailWorkspaceMessage;
const seed = { id: "Seed01", mailboxId: "Box001", origin: { kind: "derive", messageId: "Msg001" }, content: { body: "Hello" } };
const draft = { id: "Draft1", revision: 1, creationOutcome: "created" };

describe.skipIf(isServer)("Use as new", () => {
  const m = modules!;
  const originalFetch = globalThis.fetch;
  let dom: DomTestHarness;
  let dispose = () => {};
  let calls: string[];

  beforeEach(() => {
    dom = createDomTestHarness();
    document.documentElement.lang = "en";
    calls = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
        calls.push(url.pathname);
        if (url.pathname.endsWith("/draft-seeds/materialize")) return Response.json(draft);
        if (url.pathname.endsWith("/draft-seeds")) return Response.json(seed);
        return Response.json({});
      },
      { preconnect: originalFetch.preconnect },
    );
  });
  afterEach(() => {
    dispose();
    m.ui.dialogCore.close();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  });

  test("creates the draft from the message and opens it as a window, without leaving the page", async () => {
    const opened = spyOn(m.windows, "openDraftWindow").mockImplementation(() => undefined);
    const path = window.location.pathname + window.location.search;
    try {
      const derive = createRoot((done) => {
        dispose = done;
        return m.derive.createMailMessageDerive({
          mailboxId: () => "Box001",
          identities: () => [identity],
          selection: () => "Conv01",
          shows: (messageId) => messageId === "Msg001",
          explainSenderUnavailable: () => undefined,
        });
      });
      void derive.derive("edit_as_new", message);
      await waitFor(() => [...document.querySelectorAll("button")].some((button) => button.textContent?.includes("Continue")));
      [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Continue"))!.click();
      await waitFor(() => opened.mock.calls.length > 0);
      expect(calls).toEqual(["/api/mail/mailboxes/Box001/draft-seeds", "/api/mail/mailboxes/Box001/draft-seeds/materialize"]);
      expect(opened.mock.calls[0]![0]).toBe("Draft1");
      expect(opened.mock.calls[0]![1]).toMatchObject({ mailboxId: "Box001", fresh: true });
      expect(window.location.pathname + window.location.search).toBe(path);
    } finally {
      opened.mockRestore();
    }
  });
});

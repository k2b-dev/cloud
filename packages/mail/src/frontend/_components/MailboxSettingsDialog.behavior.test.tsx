import { afterEach, describe, expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { DEFAULT_MAIL_CONTACT_DIRECTORY } from "../../contact-directory-settings";
import type { MailboxSettingsContext } from "../../settings-context";

const mailboxId = "00000000-0000-4000-8000-000000000001";
const now = "2026-08-11T10:00:00.000Z";
const context: MailboxSettingsContext = {
  mailbox: {
    id: mailboxId,
    name: "Support",
    description: "Customer conversations",
    health: "active",
    healthReason: null,
    syncEnabled: true,
    searchBackend: "auto",
    automaticReplyManagementPermission: "admin",
    accessScope: "mailbox",
    composeSafety: { internalDomains: ["example.test"], largeRecipientThreshold: 20 },
    createdAt: now,
    updatedAt: now,
  },
  permission: "read",
  integrations: { spacesCalendar: true },
  organization: { savedViews: [], localTags: [] },
  compose: null,
  admin: null,
};

const settle = async () => {
  await Promise.resolve();
  await Bun.sleep(20);
};

const responseFetch = (response: Response): typeof fetch =>
  Object.assign(() => Promise.resolve(response), { preconnect: globalThis.fetch.preconnect });

describe("Mailbox settings dialog query lifecycle", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  const originalFetch = globalThis.fetch;
  afterEach(async () => {
    const { dialogCore } = await import("@k2b/ui");
    dialogCore.close();
    globalThis.fetch = originalFetch;
    await settle();
  });

  test("renders settings after the settings context request completes", async () => {
    const dom = createDomTestHarness();
    globalThis.fetch = responseFetch(Response.json(context));
    const { dialogCore } = await import("@k2b/ui");
    const { openMailboxSettingsDialog } = await import("./MailboxSettingsDialog");

    const result = openMailboxSettingsDialog({
      mailboxId,
      contactDirectory: DEFAULT_MAIL_CONTACT_DIRECTORY,
      currentUserEmail: "reader@example.test",
      initialTab: "reading",
    });
    try {
      await settle();
      expect(dom.document.body.textContent).toContain("Message display");
      expect(dom.document.body.textContent).not.toContain("Loading mailbox settings");
    } finally {
      dialogCore.close();
      await result;
      dom.cleanup();
    }
  });

  test("does not keep loading after an empty successful response", async () => {
    const dom = createDomTestHarness();
    const responses = [Response.json(null), Response.json(context)];
    globalThis.fetch = Object.assign(() => Promise.resolve(responses.shift()!), { preconnect: globalThis.fetch.preconnect });
    const { dialogCore } = await import("@k2b/ui");
    const { openMailboxSettingsDialog } = await import("./MailboxSettingsDialog");

    const result = openMailboxSettingsDialog({
      mailboxId,
      contactDirectory: DEFAULT_MAIL_CONTACT_DIRECTORY,
      currentUserEmail: "reader@example.test",
    });
    try {
      await settle();
      expect(dom.document.body.textContent).toContain("Could not load mailbox settings");
      expect(dom.document.body.textContent).not.toContain("Loading mailbox settings");
      const retry = Array.from(dom.document.querySelectorAll("button")).find((button) => button.textContent?.includes("Retry"));
      expect(retry).toBeDefined();
      retry!.click();
      await settle();
      expect(dom.document.body.textContent).toContain("Message display");
      expect(dom.document.body.textContent).not.toContain("Could not load mailbox settings");
    } finally {
      dialogCore.close();
      await result;
      dom.cleanup();
    }
  });

  test("a mailbox administrator renames the mailbox in General and only its name is sent", async () => {
    const dom = createDomTestHarness();
    const adminContext: MailboxSettingsContext = {
      ...context,
      permission: "admin",
      admin: { accessEntries: [], bindings: [], connections: [], folders: [], identities: [] },
    };
    const requests: { method: string; url: string; body: unknown }[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(new URL(input instanceof Request ? input.url : String(input), "http://cloud.test"), init);
        const body = request.method === "PATCH" ? await request.json() : null;
        requests.push({ method: request.method, url: new URL(request.url).pathname, body });
        if (request.method === "PATCH") {
          const patch = body as { name: string; description: string | null };
          return Response.json({ ...adminContext.mailbox, name: patch.name, description: patch.description });
        }
        return Response.json(adminContext);
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    const { dialogCore } = await import("@k2b/ui");
    const { openMailboxSettingsDialog } = await import("./MailboxSettingsDialog");

    const result = openMailboxSettingsDialog({
      mailboxId,
      contactDirectory: DEFAULT_MAIL_CONTACT_DIRECTORY,
      currentUserEmail: "admin@example.test",
    });
    try {
      await settle();
      const tabs = Array.from(dom.document.querySelectorAll('[role="tab"]'), (tab) => tab.textContent);
      expect(tabs.indexOf("General")).toBe(tabs.indexOf("Organization") - 1);
      expect(dom.document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("General");
      const input = dom.document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
      expect(input.value).toBe("Support");

      const save = () =>
        Array.from(dom.document.querySelectorAll("button")).find((button) => button.textContent?.includes("Save changes"))!;
      input.value = "   ";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
      expect(dom.document.body.textContent).toContain("Name is required");
      expect(save().disabled).toBe(true);

      input.value = "x".repeat(161);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
      expect(dom.document.body.textContent).toContain("Use at most 160 characters");
      expect(save().disabled).toBe(true);

      input.value = "  Sales North  ";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
      expect(save().disabled).toBe(false);
      save().click();
      await settle();

      const patch = requests.find((request) => request.method === "PATCH");
      expect(patch?.url).toBe(`/api/mail/mailboxes/${mailboxId}`);
      expect(patch?.body).toEqual({
        name: "Sales North",
        description: "Customer conversations",
        composeSafety: { internalDomains: ["example.test"], largeRecipientThreshold: 20 },
      });
      expect(input.value).toBe("Sales North");
      expect(dom.document.body.textContent).toContain("No unsaved changes");
      dialogCore.close();
      expect(await result).toEqual({ deleted: false, workspaceChanged: true });
    } finally {
      dialogCore.close();
      await result;
      dom.cleanup();
    }
  });
});

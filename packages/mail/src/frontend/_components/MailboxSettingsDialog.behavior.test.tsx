import { afterEach, describe, expect, test } from "bun:test";
import type { AccessEntry } from "@k2b/cloud/contracts";
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
    draftEditMode: "lock",
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
      admin: { accessEntries: [], code: null, messageCount: null, bindings: [], connections: [], folders: [], identities: [] },
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

  // N1-mail-inline, mockup v31 `editor · A`: Mail shares a mailbox through the shared access dialog. The handle is looked
  // up as it is typed, the hit names what it is, and Code rows have their own section with link and explanation.
  test("a mailbox administrator shares the mailbox through the shared access dialog", async () => {
    const dom = createDomTestHarness();
    const accountId = "20000000-0000-4000-8000-000000000001";
    const manager: AccessEntry = {
      id: "grant-manager",
      principal: { type: "user", userId: "manager" },
      displayName: "Mia Admin",
      permission: "admin",
      createdAt: now,
    };
    const stored: AccessEntry = {
      id: "grant-code",
      principal: { type: "service_account", serviceAccountId: "20000000-0000-4000-8000-000000000002" },
      displayName: "Code of support@example.test",
      permission: "write",
      serviceAccountKind: "code",
      serviceAccountDescription: "Service account of a mailbox",
      serviceAccountHref: `/app/mail/${mailboxId}/code`,
      createdAt: now,
    };
    const added: AccessEntry = {
      id: "grant-new",
      principal: { type: "service_account", serviceAccountId: accountId },
      displayName: "Code of Werkstatt",
      permission: "write",
      serviceAccountKind: "code",
      serviceAccountDescription: "Service account of an app",
      createdAt: now,
    };
    let entries = [manager, stored];
    const adminContext = (): MailboxSettingsContext => ({
      ...context,
      permission: "admin",
      admin: { accessEntries: entries, code: null, messageCount: null, bindings: [], connections: [], folders: [], identities: [] },
    });
    const requests: { method: string; url: URL; body: unknown }[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(new URL(input instanceof Request ? input.url : String(input), "http://cloud.test"), init);
        const url = new URL(request.url);
        const body = request.method === "POST" ? await request.json() : null;
        requests.push({ method: request.method, url, body });
        if (url.pathname === "/api/accounts/entities")
          return Response.json({
            items: [
              {
                kind: "service_account",
                serviceAccount: {
                  id: accountId,
                  kind: "code",
                  name: "Code of Werkstatt",
                  handle: "code-7k2q9m4xwt",
                  description: "Service account of an app",
                },
              },
            ],
          });
        if (request.method === "POST" && url.pathname.endsWith(`/mailboxes/${mailboxId}/access`)) {
          entries = [...entries, added];
          return Response.json(added);
        }
        return Response.json(adminContext());
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    const { dialogCore } = await import("@k2b/ui");
    const { openMailboxSettingsDialog } = await import("./MailboxSettingsDialog");
    const buttons = () => Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button"));
    const button = (text: string) => buttons().find((node) => node.textContent?.trim() === text);
    const accountsSection = () =>
      Array.from(dom.document.querySelectorAll("section")).find((node) =>
        node.querySelector("h3")?.textContent?.startsWith("Service accounts"),
      );

    const result = openMailboxSettingsDialog({
      mailboxId,
      contactDirectory: DEFAULT_MAIL_CONTACT_DIRECTORY,
      currentUserEmail: "admin@example.test",
      initialTab: "access",
    });
    try {
      await settle();
      // The tab shows who has access and one way into the dialog; it has no search, step or rows of its own.
      expect(button("Search")).toBeUndefined();
      expect(dom.document.querySelector('input[aria-label="Handle of the service account"]')).toBeNull();
      button("Edit access")!.click();
      await settle();
      const section = accountsSection()!;
      expect(section.querySelector("h3")?.textContent).toBe("Service accounts 1");
      const row = Array.from(section.querySelectorAll("li")).find((node) => node.textContent?.includes("Code of support@example.test"))!;
      expect(row.textContent).toContain("Service account of a mailbox · may edit");
      expect(row.querySelector("a")?.getAttribute("href")).toBe(`/app/mail/${mailboxId}/code`);
      expect(section.textContent).toContain(
        "Code runs as the service account of its object. Whoever manages “Support” gives it access here",
      );

      button("Add service account")!.click();
      await settle();
      const field = dom.document.querySelector<HTMLInputElement>('input[aria-label="Handle of the service account"]')!;
      field.value = "code-7k2q9m4xwt";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
      // Found as it is typed: no Find or Search step, the hit with its description and its mark.
      expect(button("Search")).toBeUndefined();
      expect(button("Find")).toBeUndefined();
      // The dialog also reads e-mails and the number of people from the directory; the handle lookup is the search.
      const lookup = requests.find(
        (request) => request.url.pathname === "/api/accounts/entities" && request.url.searchParams.has("search"),
      )!;
      expect(Object.fromEntries(lookup.url.searchParams)).toMatchObject({
        search: "code-7k2q9m4xwt",
        target_type: "mail.mailbox",
        target_id: mailboxId,
      });
      const hit = Array.from(section.querySelectorAll<HTMLButtonElement>("li button")).find((node) =>
        node.textContent?.includes("Code of Werkstatt"),
      )!;
      expect(hit.textContent).toContain("Service account of an app");
      expect(hit.querySelector(".k2b-status-badge")?.textContent).toBe("Service account");
      hit.click();
      await settle();
      expect(requests.some((request) => request.method === "POST")).toBe(false);
      button("Save")!.click();
      await settle();
      await settle();
      const grant = requests.find((request) => request.method === "POST")!;
      expect(grant.url.pathname).toBe(`/api/mail/mailboxes/${mailboxId}/access`);
      expect(grant.body).toEqual({
        principal: { type: "service_account", serviceAccountId: accountId },
        permission: "write",
        scope: "mailbox",
      });
      // The tab reads the stored list again, so its summary counts the new account.
      expect(dom.document.body.textContent).toContain("2 service accounts");
    } finally {
      dialogCore.close();
      await result;
      dom.cleanup();
    }
  });

  // A save can fail halfway: the saved part stays saved, and after Discard the tab still reads the stored list again.
  test("a scoped level is saved as assigned and a half-saved change reloads the tab after Discard", async () => {
    const dom = createDomTestHarness();
    const person = (id: string, displayName: string, permission: AccessEntry["permission"], scope?: string): AccessEntry => ({
      id,
      principal: { type: "user", userId: `user-${id}` },
      displayName,
      permission,
      ...(scope ? { scope } : {}),
      createdAt: now,
    });
    let entries = [
      person("grant-mia", "Mia Admin", "admin"),
      person("grant-jonas", "Jonas Weber", "write"),
      person("grant-lea", "Lea Schmitt", "read"),
    ];
    const adminContext = (): MailboxSettingsContext => ({
      ...context,
      permission: "admin",
      admin: { accessEntries: entries, code: null, messageCount: null, bindings: [], connections: [], folders: [], identities: [] },
    });
    const requests: { method: string; path: string; body: unknown }[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(new URL(input instanceof Request ? input.url : String(input), "http://cloud.test"), init);
        const path = new URL(request.url).pathname;
        const body = request.method === "PATCH" ? await request.json() : null;
        requests.push({ method: request.method, path, body });
        if (request.method === "PATCH" && path.endsWith("/access/grant-jonas")) {
          entries = entries.map((entry) => (entry.id === "grant-jonas" ? { ...entry, scope: "assigned" } : entry));
          return new Response(null, { status: 204 });
        }
        if (request.method === "DELETE") return Response.json({ message: "The mailbox is busy." }, { status: 503 });
        return Response.json(adminContext());
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    const { dialogCore } = await import("@k2b/ui");
    const { openMailboxSettingsDialog } = await import("./MailboxSettingsDialog");
    const buttons = () => Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button"));
    const button = (text: string) =>
      buttons()
        .filter((node) => node.textContent?.trim() === text)
        .at(-1);
    // The access dialog opens above the settings, whose summary lists the same names.
    const row = (name: string) =>
      Array.from(dom.document.querySelectorAll("li[data-access-key]")).find((item) => item.textContent?.includes(name))!;
    const reads = () => requests.filter((request) => request.method === "GET" && !request.path.includes("/access")).length;

    const result = openMailboxSettingsDialog({
      mailboxId,
      contactDirectory: DEFAULT_MAIL_CONTACT_DIRECTORY,
      currentUserEmail: "admin@example.test",
      initialTab: "access",
    });
    try {
      await settle();
      button("Edit access")!.click();
      await settle();
      row("Jonas Weber").querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click();
      Array.from(row("Jonas Weber").querySelectorAll<HTMLElement>('[role="radio"]'))
        .find((option) => option.textContent?.includes("Edit assigned only"))!
        .click();
      await settle();
      dom.document.querySelector<HTMLButtonElement>('button[aria-label="Remove Lea Schmitt"]')!.click();
      await settle();
      const before = reads();
      button("Save")!.click();
      await settle();
      // Lea loses access, so Save asks once more.
      button("Remove access")!.click();
      await settle();
      await settle();
      expect(requests.find((request) => request.method === "PATCH")).toEqual({
        method: "PATCH",
        path: `/api/mail/mailboxes/${mailboxId}/access/grant-jonas`,
        body: { permission: "write", scope: "assigned" },
      });
      expect(requests.some((request) => request.method === "DELETE")).toBe(true);
      expect(dom.document.body.textContent).toContain("Not saved");
      // Nothing reads the list while the dialog still holds the open change.
      expect(reads()).toBe(before);
      button("Cancel")!.click();
      await settle();
      button("Discard")!.click();
      await settle();
      await settle();
      expect(reads()).toBe(before + 1);
      expect(dom.document.querySelector('[role="dialog"] h2, dialog h2')?.textContent).not.toContain("Access to Support");
    } finally {
      dialogCore.close();
      await result;
      dom.cleanup();
    }
  });
});

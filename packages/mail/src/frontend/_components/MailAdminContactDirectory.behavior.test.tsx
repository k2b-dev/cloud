import { afterEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { MAIL_CONTACT_DIRECTORY_DEFAULTS } from "../../contact-directory-settings";
import type { ContactDirectoryAdminView } from "../../service/contact-directory";

const settle = async () => {
  await Promise.resolve();
  await Bun.sleep(30);
};

const crm = { appId: "crm", suggest: "customer.suggest", resolve: "customer.match", read: "", listWritableBooks: "", create: "" };
const view: ContactDirectoryAdminView = {
  config: crm,
  apps: [
    {
      appId: "contacts",
      appName: "Contacts",
      appIcon: "ti ti-address-book",
      capabilities: {
        suggest: [{ id: "contact.suggest", title: "Suggest contacts" }],
        resolve: [{ id: "contact.resolve", title: "Resolve contacts" }],
        read: [{ id: "contact.read", title: "Read contact" }],
        listWritableBooks: [{ id: "book.list", title: "List books" }],
        create: [{ id: "contact.create", title: "Create contact" }],
      },
    },
    {
      appId: "crm",
      appName: "CRM",
      appIcon: "",
      capabilities: {
        suggest: [{ id: "customer.suggest", title: "Suggest customers" }],
        resolve: [{ id: "customer.match", title: "Match customers" }],
        read: [],
        listWritableBooks: [],
        create: [],
      },
    },
  ],
  issues: [],
};

describe("Mail admin contact directory dialog", () => {
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

  test("opens from the summary, shows field errors, and saves the Contacts defaults", async () => {
    const dom = createDomTestHarness();
    const bodies: unknown[] = [];
    const responses = [
      Response.json(
        {
          message: "Mail cannot use this mapping yet.",
          code: "CONTACT_DIRECTORY_INVALID",
          issues: [
            { field: "resolve", code: "capability_missing", message: "“Match participants”: customer.match does not exist in this app." },
          ],
        },
        { status: 400 },
      ),
      Response.json(MAIL_CONTACT_DIRECTORY_DEFAULTS),
    ];
    globalThis.fetch = Object.assign(
      async (_url: unknown, init?: RequestInit) => {
        bodies.push({ method: init?.method, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
        return responses.shift() ?? Response.json({ message: "unexpected" }, { status: 500 });
      },
      { preconnect: originalFetch.preconnect },
    );
    const { default: MailAdminContactDirectory } = await import("./MailAdminContactDirectory.island");
    const dispose = render(() => createComponent(MailAdminContactDirectory, { view }), dom.root);
    const button = (label: string) => {
      const found = Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find(
        (candidate) => candidate.textContent?.trim() === label,
      );
      if (!found) throw new Error(`Missing button: ${label}`);
      return found;
    };
    const summary = () => dom.document.querySelector('[data-testid="mail-contact-directory-summary"]')?.textContent;

    try {
      expect(summary()).toBe("CRM · Custom");
      button("Configure").click();
      await settle();
      const dialog = dom.document.querySelector("dialog");
      expect(dialog?.textContent).toContain("Contact directory");
      expect(dialog?.textContent).toContain("Suggest recipients");

      button("Save").click();
      await settle();
      expect(bodies[0]).toEqual({ method: "PUT", body: crm });
      expect(dom.document.querySelector('[role="alert"]')?.textContent).toContain("Mail cannot use this mapping yet.");
      const resolveField = dom.document.getElementById("mail-contact-directory-resolve");
      expect(resolveField?.getAttribute("aria-invalid")).toBe("true");
      expect(dom.document.activeElement).toBe(resolveField);
      expect(dom.document.querySelector("dialog")?.textContent).toContain("customer.match does not exist in this app.");

      button("Use Contacts defaults").click();
      await settle();
      expect(dom.document.querySelector('[role="alert"]')).toBeNull();
      button("Save").click();
      await settle();
      expect(bodies[1]).toEqual({ method: "PUT", body: MAIL_CONTACT_DIRECTORY_DEFAULTS });
      expect(dom.document.querySelector("dialog[open]")).toBeNull();
      expect(summary()).toBe("Contacts · Defaults");
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("closes with Escape without saving", async () => {
    const dom = createDomTestHarness();
    let requests = 0;
    globalThis.fetch = Object.assign(
      async () => {
        requests += 1;
        return Response.json({ message: "unexpected" }, { status: 500 });
      },
      { preconnect: originalFetch.preconnect },
    );
    const { default: MailAdminContactDirectory } = await import("./MailAdminContactDirectory.island");
    const dispose = render(() => createComponent(MailAdminContactDirectory, { view }), dom.root);
    const configure = () =>
      Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find(
        (candidate) => candidate.textContent?.trim() === "Configure",
      );
    try {
      configure()?.click();
      await settle();
      const dialog = dom.document.querySelector("dialog");
      expect(dialog?.textContent).toContain("Suggest recipients");
      dialog?.dispatchEvent(new Event("cancel", { cancelable: true }));
      await settle();
      expect(dom.document.querySelector("dialog")?.textContent ?? "").not.toContain("Suggest recipients");
      expect(requests).toBe(0);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});

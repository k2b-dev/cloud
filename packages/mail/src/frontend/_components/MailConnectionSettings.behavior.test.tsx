import { afterEach, describe, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { Mailbox, ProviderBinding, ProviderConnection } from "../../contracts";
import type { MailboxAdminSettingsContext } from "../../settings-context";

const now = "2026-09-24T10:00:00.000Z";
const connectionId = "00000000-0000-4000-8000-00000000000c";
const bindingId = "00000000-0000-4000-8000-00000000000b";

const mailbox: Mailbox = {
  id: "Mbx123",
  name: "Support",
  description: null,
  health: "active",
  healthReason: null,
  syncEnabled: true,
  searchBackend: "auto",
  automaticReplyManagementPermission: "admin",
  composeSafety: { internalDomains: [], largeRecipientThreshold: 20 },
  createdAt: now,
  updatedAt: now,
};

const connection: ProviderConnection = {
  id: connectionId,
  mailboxId: "Mbx123",
  name: "Uni account",
  email: "person@example.test",
  username: "person@example.test",
  connectorKind: "imap_smtp",
  imap: { host: "imap.example.test", port: 993, tlsMode: "implicit" },
  smtp: { host: "smtp.example.test", port: 587, tlsMode: "starttls" },
  secret: { kind: "password", isSet: true },
  status: "active",
  authenticatedPrincipal: "person@example.test",
  limits: {
    checkedAt: now,
    imap: { status: "unavailable", storage: null, messages: null },
    smtp: { status: "unavailable", maxMessageBytes: null, dsn: false },
  },
  lastVerifiedAt: now,
  lastError: null,
  createdAt: now,
  updatedAt: now,
};

const binding: ProviderBinding = {
  id: bindingId,
  mailboxId: "Mbx123",
  connectionId,
  state: "active",
  authenticatedPrincipal: "person@example.test",
  capabilities: {},
  lastVerifiedAt: now,
  lastError: null,
  createdAt: now,
  updatedAt: now,
};

const connectedAdmin: MailboxAdminSettingsContext = {
  accessEntries: [],
  bindings: [binding],
  connections: [connection],
  folders: [],
  identities: [],
};

const settle = async () => {
  await Promise.resolve();
  await Bun.sleep(30);
};

type Call = { method: string; url: string; body: unknown };

describe("Mail connection settings recovery", () => {
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

  const mockFetch = (responses: Response[]) => {
    const calls: Call[] = [];
    globalThis.fetch = Object.assign(
      async (url: unknown, init?: RequestInit) => {
        calls.push({
          method: init?.method ?? "GET",
          url: String(url),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });
        return responses.shift() ?? Response.json({ message: "unexpected" }, { status: 500 });
      },
      { preconnect: originalFetch.preconnect },
    );
    return calls;
  };

  const mount = async (
    options: { locale?: string; admin?: MailboxAdminSettingsContext; afterReload?: MailboxAdminSettingsContext } = {},
  ) => {
    const dom = createDomTestHarness();
    const [{ MailConnectionSettings }, { LocaleProvider }] = await Promise.all([import("./MailConnectionSettings"), import("@k2b/ui")]);
    const [admin, setAdmin] = createSignal(options.admin ?? connectedAdmin);
    const dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: options.locale ?? "en",
          get children() {
            return createComponent(MailConnectionSettings, {
              mailbox,
              get admin() {
                return admin();
              },
              currentUserEmail: "person@example.test",
              reloading: false,
              onReload: async () => {
                if (options.afterReload) setAdmin(options.afterReload);
              },
              onWorkspaceChange: () => undefined,
            });
          },
        }),
      dom.root,
    );
    const button = (label: string) => {
      const found = Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find(
        (candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
      );
      if (!found) throw new Error(`Missing button: ${label}`);
      return found;
    };
    const fill = (label: string, value: string) => {
      const field = Array.from(dom.document.querySelectorAll<HTMLInputElement>("input")).find(
        (input) => input.labels?.[0]?.textContent?.includes(label) || input.getAttribute("aria-label") === label,
      );
      if (!field) throw new Error(`Missing field: ${label}`);
      field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const text = () => dom.document.body.textContent ?? "";
    return { dom, button, fill, text, dispose: () => (dispose(), dom.cleanup()) };
  };

  test("offers sender setup again after receiving connected and names the failed step", async () => {
    const calls = mockFetch([
      Response.json({ code: "NOT_FOUND", message: "Active provider binding not found" }, { status: 404 }),
      Response.json({ code: "PROVIDER_BUSY", message: "Provider work is still running" }, { status: 409 }),
      Response.json({ id: "Snd123", fromAddress: "person@example.test" }),
    ]);
    const view = await mount();
    try {
      expect(view.text()).toContain("Sending is not configured");
      view.button("Set up sending").click();
      await settle();

      const alert = view.dom.document.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("Receiving is connected; sending is not set up yet");
      expect(alert?.textContent).toContain("Setting up the default sender failed: Active provider binding not found");
      expect(alert?.textContent).toContain("You don't need to reconnect the account or enter the password again.");

      view.button("Set up sending").click();
      await settle();
      const status = view.dom.document.querySelector('[role="status"]');
      expect(status?.textContent).toContain("Synchronization is running right now. Try again in a moment.");
      expect(view.dom.document.querySelector('[role="alert"]')).toBeNull();

      view.button("Set up sending").click();
      await settle();
      expect(view.text()).not.toContain("Receiving is connected; sending is not set up yet");
      expect(calls).toHaveLength(3);
      for (const call of calls) {
        expect(call.method).toBe("POST");
        expect(call.url).toEndWith("/mailboxes/Mbx123/sender-identities/default/setup");
        expect(call.body).toEqual({ bindingId, savesSentAutomatically: false });
      }
    } finally {
      view.dispose();
    }
  });

  test("keeps receiving and shows the sender retry when setup fails right after connecting", async () => {
    const calls = mockFetch([
      Response.json({ connection, verification: {} }),
      Response.json(binding),
      Response.json({ code: "NOT_FOUND", message: "Die angeforderte Mail-Ressource wurde nicht gefunden" }, { status: 404 }),
    ]);
    const view = await mount({ locale: "de", admin: { ...connectedAdmin, bindings: [], connections: [] }, afterReload: connectedAdmin });
    try {
      view.button("Konto verbinden").click();
      await settle();
      view.fill("IMAP-Host", "imap.example.test");
      view.fill("SMTP-Host", "smtp.example.test");
      view.fill("Passwort", "secret");
      await settle();
      view.button("Prüfen und verbinden").click();
      await settle();

      expect(calls.map((call) => call.url.replace(/^.*\/mailboxes/, "/mailboxes"))).toEqual([
        "/mailboxes/Mbx123/connections",
        "/mailboxes/Mbx123/bindings",
        "/mailboxes/Mbx123/sender-identities/default/setup",
      ]);
      expect(view.dom.document.querySelector("dialog[open]")).toBeNull();
      const alert = view.dom.document.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("Empfang verbunden, Versand ist noch nicht eingerichtet");
      expect(alert?.textContent).toContain("Du musst das Konto nicht neu verbinden und das Passwort nicht erneut eingeben.");
      expect(view.button("Versand einrichten")).toBeDefined();
    } finally {
      view.dispose();
    }
  });

  test("explains running synchronization while verifying an edited account and retries the same request", async () => {
    const calls = mockFetch([
      Response.json(
        { code: "PROVIDER_BUSY", message: "Die Synchronisierung läuft gerade. Versuche es in einem Moment erneut." },
        { status: 409 },
      ),
      Response.json({ connection, verification: {} }),
    ]);
    const view = await mount({ locale: "de" });
    try {
      view.button("Aktionen für das verbundene Konto").click();
      await settle();
      view.button("Konto bearbeiten").click();
      await settle();
      view.fill("Passwort", "secret");
      await settle();
      view.button("Prüfen und speichern").click();
      await settle();

      const dialog = view.dom.document.querySelector("dialog[open]");
      expect(dialog?.querySelector('[role="status"]')?.textContent).toContain("Synchronisierung läuft");
      expect(dialog?.textContent).toContain("Deine Eingaben bleiben erhalten");
      expect(view.dom.document.querySelector('[role="alertdialog"]')).toBeNull();

      view.button("Erneut versuchen").click();
      await settle();
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual(calls[0]!);
      expect(calls[0]?.method).toBe("PUT");
      expect(view.dom.document.querySelector("dialog[open]")).toBeNull();
    } finally {
      view.dispose();
    }
  });
});

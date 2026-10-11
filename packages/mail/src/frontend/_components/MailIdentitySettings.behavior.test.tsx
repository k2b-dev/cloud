import { afterEach, describe, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { Mailbox, ProviderBinding, SenderIdentity } from "../../contracts";
import type { MailboxAdminSettingsContext } from "../../settings-context";

// Load once outside any test, so the cold Solid transform of the settings' source graph does not count against the
// test timeout. The @k2b/ui browser build needs a document while its modules evaluate.
const load = async () => {
  const dom = createDomTestHarness();
  try {
    const { MailIdentitySettings } = await import("./MailIdentitySettings");
    const { LocaleProvider } = await import("@k2b/ui");
    return { MailIdentitySettings, LocaleProvider };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

const now = "2026-10-11T10:00:00.000Z";
const commandId = "00000000-0000-4000-8000-0000000000aa";

const mailbox: Mailbox = {
  id: "Mbx123",
  name: "Support",
  description: null,
  health: "active",
  healthReason: null,
  syncEnabled: true,
  searchBackend: "auto",
  automaticReplyManagementPermission: "admin",
  accessScope: "mailbox",
  composeSafety: { internalDomains: [], largeRecipientThreshold: 20 },
  createdAt: now,
  updatedAt: now,
};

const binding: ProviderBinding = {
  id: "00000000-0000-4000-8000-00000000000b",
  mailboxId: "Mbx123",
  connectionId: "00000000-0000-4000-8000-00000000000c",
  state: "active",
  authenticatedPrincipal: "person@example.test",
  capabilities: {},
  lastVerifiedAt: now,
  lastError: null,
  createdAt: now,
  updatedAt: now,
};

const identity = (pendingVerificationCommandId: string | null, status: SenderIdentity["status"]): SenderIdentity => ({
  id: "Snd123",
  mailboxId: "Mbx123",
  label: "Support desk",
  displayName: "Support",
  fromAddress: "person@example.test",
  replyTo: null,
  defaultCc: [],
  defaultBcc: [],
  defaultFormat: "markdown",
  defaultPriority: "normal",
  defaultDeliveryReceipt: false,
  defaultReadReceipt: false,
  vcard: null,
  envelopeSender: null,
  defaultSignatureTemplateId: null,
  transport: {
    mode: "mailbox",
    host: null,
    port: null,
    tlsMode: null,
    username: null,
    secret: { kind: null, isSet: false },
    revision: 0,
    status: "active",
    capabilities: { dsn: false, size: false, maxMessageBytes: null },
    lastVerifiedAt: null,
    lastError: null,
  },
  authenticationPolicy: { automation: "disabled" },
  sentFolderId: null,
  draftsFolderId: null,
  isDefault: true,
  status,
  statusReason: status === "verified" ? null : pendingVerificationCommandId ? "verification_pending" : "verification_required",
  pendingVerificationCommandId,
  createdAt: now,
  updatedAt: now,
});

const admin = (identities: SenderIdentity[]): MailboxAdminSettingsContext => ({
  accessEntries: [],
  bindings: [binding],
  connections: [],
  folders: [],
  identities,
});

describe("Mail identity settings with a verification that waits behind synchronization", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("shows the pending verification, follows its command, and shows the verified identity once it ran", async () => {
    const outcomes = [[{ id: commandId, state: "queued", code: null }], [{ id: commandId, state: "confirmed", code: null }]];
    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = Object.assign(
      async (url: unknown, init?: RequestInit) => {
        requests.push({ url: String(url), body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
        return Response.json(outcomes.shift() ?? []);
      },
      { preconnect: originalFetch.preconnect },
    );
    const dom = createDomTestHarness();
    const { MailIdentitySettings, LocaleProvider } = modules!;
    const [current, setCurrent] = createSignal(admin([identity(commandId, "unverified")]));
    let reloads = 0;
    const dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: "de",
          get children() {
            return createComponent(MailIdentitySettings, {
              mailbox,
              get admin() {
                return current();
              },
              mailboxSignatures: [],
              currentUserEmail: "person@example.test",
              reloading: false,
              onReload: async () => {
                reloads += 1;
                setCurrent(admin([identity(null, "verified")]));
              },
              onWorkspaceChange: () => undefined,
            });
          },
        }),
      dom.root,
    );
    try {
      const text = () => dom.document.body.textContent ?? "";
      expect(text()).toContain("Bestätigung wartet");
      const verify = Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === "Bestätigen",
      );
      // The button keeps its place while the verification waits, so the row does not shift.
      expect(verify?.disabled).toBe(true);

      await Bun.sleep(4_600);
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.url).toEndWith("/mailboxes/Mbx123/commands/outcomes");
        expect(request.body).toEqual({ commandIds: [commandId] });
      }
      expect(reloads).toBe(1);
      expect(text()).not.toContain("Bestätigung wartet");
      expect(text()).toContain("Bereit");
    } finally {
      dispose();
      dom.cleanup();
    }
  }, 15_000);
});

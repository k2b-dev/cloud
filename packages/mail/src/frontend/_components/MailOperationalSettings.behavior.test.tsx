import { afterEach, describe, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { Mailbox, MailboxOperationalHealth, MailboxOperatorOperations } from "../../contracts";

const now = "2026-09-24T10:00:00.000Z";

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

const health: MailboxOperationalHealth = {
  mailboxId: "Mbx123",
  health: "active",
  healthReason: null,
  syncEnabled: true,
  bindings: { total: 0, active: 0, degraded: 0, pending: 0, revoked: 0, lastVerifiedAt: null, rightsSources: {} },
  discovery: { generation: 1, lastAt: now, activeFolders: 2, missingFolders: 0, ambiguousFolders: 0, subscribedFolders: 2 },
  sync: { lastAt: now, lagSeconds: 0, runningRuns: 0, failedRuns: 0, folderStates: { current: 2 } },
  hydration: { complete: 0, pending: 0, failed: 0 },
  commands: { states: {}, maintenanceQueued: 0 },
  outbox: { states: {} },
  search: { configuredBackend: "auto", pgTextsearchInstalled: false, bm25Ready: false },
};

const folder = (id: string, name: string, path: string): MailboxOperatorOperations["folders"][number] => ({
  id,
  name,
  path,
  discoveryState: "active",
  syncStatus: "current",
  selectedForSync: true,
  actions: [],
});

const operations: MailboxOperatorOperations = {
  mailboxId: "Mbx123",
  mailboxName: "Support",
  health: "active",
  syncEnabled: true,
  sync: { lastAt: now, lagSeconds: 0, states: {} },
  coverage: { hydration: { total: 0, covered: 0 }, search: { total: 0, covered: 0 }, threads: { total: 0, covered: 0 } },
  queues: { commands: {}, outbox: {}, workflows: {}, automaticReplies: {}, automaticReplySuppressions: {} },
  connectors: { activeBindings: 0, degradedBindings: 0, capabilities: {}, pushModes: {}, pushStates: {}, draftProjectionStates: {} },
  search: { configuredBackend: "auto", effectiveBackend: "postgres", fallbackActive: false },
  references: { configured: false, allocated: 0 },
  folders: [folder("FdA111", "Archiv", "Archiv"), folder("FdB222", "Archiv", "Projekte / 2025 / Archiv")],
  recentCommands: [],
  attentionCommands: [],
  attentionCount: 0,
  nextAttentionCursor: null,
  actions: [],
  generatedAt: now,
};

describe("Mail folder maintenance", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("names each folder by its full path", async () => {
    globalThis.fetch = Object.assign(async () => Response.json(operations), { preconnect: originalFetch.preconnect });
    const dom = createDomTestHarness();
    const [{ default: MailOperationalSettings }, { LocaleProvider }] = await Promise.all([
      import("./MailOperationalSettings"),
      import("@k2b/ui"),
    ]);
    const dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: "en",
          get children() {
            return createComponent(MailOperationalSettings, {
              mailbox,
              health,
              bindings: [],
              connections: [],
              dateConfig: { locale: "en", timeZone: "UTC" },
              reloading: false,
              onReload: async () => undefined,
              onWorkspaceChange: () => undefined,
            });
          },
        }),
      dom.root,
    );
    try {
      await Bun.sleep(30);
      const text = dom.document.body.textContent ?? "";
      expect(text).toContain("Folder maintenance");
      expect(text).toContain("Projekte / 2025 / Archiv");
      expect(dom.document.querySelector('[title="Projekte / 2025 / Archiv"]')).not.toBeNull();
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("offers Sync now only when the account is connected", async () => {
    globalThis.fetch = Object.assign(async () => Response.json(operations), { preconnect: originalFetch.preconnect });
    const dom = createDomTestHarness();
    const [{ default: MailOperationalSettings }, { LocaleProvider }] = await Promise.all([
      import("./MailOperationalSettings"),
      import("@k2b/ui"),
    ]);
    const [state, setState] = createSignal<MailboxOperationalHealth["health"]>("connection_required");
    const dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: "en",
          get children() {
            return createComponent(MailOperationalSettings, {
              mailbox,
              get health() {
                return { ...health, health: state() };
              },
              bindings: [],
              connections: [],
              dateConfig: { locale: "en", timeZone: "UTC" },
              reloading: false,
              onReload: async () => undefined,
              onWorkspaceChange: () => undefined,
            });
          },
        }),
      dom.root,
    );
    const syncNow = () => Array.from(dom.document.querySelectorAll("button")).find((button) => button.textContent?.includes("Sync now"));
    try {
      expect(syncNow()?.disabled).toBe(true);
      setState("auth_required");
      expect(syncNow()?.disabled).toBe(true);
      // A timed-out sync leaves the account connected, so the next sync can recover the mailbox.
      setState("degraded");
      expect(syncNow()?.disabled).toBe(false);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("explains a timed-out synchronization instead of the generic degraded status", async () => {
    globalThis.fetch = Object.assign(async () => Response.json(operations), { preconnect: originalFetch.preconnect });
    const dom = createDomTestHarness();
    const [{ default: MailOperationalSettings }, { LocaleProvider }] = await Promise.all([
      import("./MailOperationalSettings"),
      import("@k2b/ui"),
    ]);
    const [reason, setReason] = createSignal<string | null>("Failed to establish connection in required time");
    const dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: "en",
          get children() {
            return createComponent(MailOperationalSettings, {
              mailbox,
              get health() {
                return { ...health, health: "degraded" as const, healthReason: reason() };
              },
              bindings: [],
              connections: [],
              dateConfig: { locale: "en", timeZone: "UTC" },
              reloading: false,
              onReload: async () => undefined,
              onWorkspaceChange: () => undefined,
            });
          },
        }),
      dom.root,
    );
    const text = () => dom.document.body.textContent ?? "";
    try {
      expect(text()).toContain("The saved account is valid, but the latest synchronization timed out. Mail will retry automatically.");
      expect(text()).not.toContain("The saved account is still connected.");
      setReason("IMAP folder listing failed");
      expect(text()).toContain("The saved account is still connected. Review the connection status for details and recovery actions.");
      expect(text()).not.toContain("the latest synchronization timed out");
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});

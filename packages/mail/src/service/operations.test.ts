import { describe, expect, test } from "bun:test";
import { mailboxOperatorOperationsSchema, platformMailboxOperationSummarySchema, platformMailOperationsSchema } from "../contracts";

const mailboxId = "mbx001";

const snapshot = {
  mailboxId,
  mailboxName: "Support",
  health: "active" as const,
  syncEnabled: true,
  sync: { lastAt: null, lagSeconds: null, states: {} },
  coverage: {
    hydration: { total: 0, covered: 0 },
    search: { total: 0, covered: 0 },
    threads: { total: 0, covered: 0 },
  },
  queues: {
    commands: {},
    outbox: {},
    workflows: {},
    automaticReplies: {},
    automaticReplySuppressions: {},
  },
  connectors: {
    activeBindings: 0,
    degradedBindings: 0,
    capabilities: {},
    pushModes: {},
    pushStates: {},
    draftProjectionStates: {},
  },
  search: {
    configuredBackend: "auto" as const,
    effectiveBackend: "postgres" as const,
    fallbackActive: false,
  },
  references: { configured: false, allocated: 0 },
  folders: [],
  recentCommands: [],
  attentionCommands: [],
  attentionCount: 0,
  nextAttentionCursor: null,
  actions: [],
  generatedAt: "2026-07-21T10:00:00.000Z",
};

const platformSummary = {
  mailboxId,
  mailboxName: "Support",
  health: "active" as const,
  syncEnabled: true,
  sync: { lastAt: null, lagSeconds: null },
  coverage: snapshot.coverage,
  access: { total: 1, administrators: 1 },
  storage: null,
  attentionCount: 0,
};

describe("Mail operator read model contract", () => {
  test("accepts aggregate state without content-bearing fields", () => {
    expect(mailboxOperatorOperationsSchema.parse(snapshot)).toEqual(snapshot);
  });

  test("rejects accidental provider or message detail expansion", () => {
    expect(
      mailboxOperatorOperationsSchema.safeParse({
        ...snapshot,
        subject: "Secret subject",
      }).success,
    ).toBe(false);
    expect(
      mailboxOperatorOperationsSchema.safeParse({
        ...snapshot,
        providerEndpoint: "imap.example.com",
      }).success,
    ).toBe(false);
  });

  test("accepts redacted recent maintenance activity", () => {
    const recentCommand = {
      id: "00000000-0000-4000-8000-000000000002",
      kind: "sync_mailbox" as const,
      state: "confirmed" as const,
      attempt: 1,
      errorCode: null,
      providerEffectStarted: true,
      createdAt: "2026-07-21T09:59:00.000Z",
      updatedAt: "2026-07-21T10:00:00.000Z",
      actions: [],
    };

    expect(
      mailboxOperatorOperationsSchema.parse({
        ...snapshot,
        recentCommands: [recentCommand],
      }).recentCommands,
    ).toEqual([recentCommand]);

    expect(
      mailboxOperatorOperationsSchema.safeParse({
        ...snapshot,
        recentCommands: [{ ...recentCommand, subject: "Secret subject" }],
      }).success,
    ).toBe(false);
  });

  test("exposes a user-facing folder name without provider details", () => {
    const folder = {
      id: "fld001",
      name: "Inbox",
      path: "Inbox",
      discoveryState: "active" as const,
      syncStatus: "current",
      selectedForSync: true,
      actions: [],
    };

    expect(
      mailboxOperatorOperationsSchema.parse({
        ...snapshot,
        folders: [folder],
      }).folders,
    ).toEqual([folder]);

    expect(
      mailboxOperatorOperationsSchema.parse({
        ...snapshot,
        folders: [{ ...folder, remotePath: "INBOX" }],
      }).folders,
    ).toEqual([folder]);
  });

  test("keeps a platform-wide attention total separate from the bounded mailbox page", () => {
    expect(platformMailboxOperationSummarySchema.parse(platformSummary)).toEqual(platformSummary);
    expect(
      platformMailOperationsSchema.parse({
        mailboxes: [platformSummary],
        mailboxCount: 8,
        withoutAdministratorCount: 2,
        attentionCount: 42,
        generatedAt: snapshot.generatedAt,
        nextCursor: null,
      }).attentionCount,
    ).toBe(42);
  });

  test("keeps platform recovery aggregates redacted", () => {
    expect(
      platformMailboxOperationSummarySchema.safeParse({
        ...platformSummary,
        access: { ...platformSummary.access, principals: ["person@example.com"] },
      }).success,
    ).toBe(false);
  });
});

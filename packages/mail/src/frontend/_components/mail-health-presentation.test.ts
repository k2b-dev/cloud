import { describe, expect, test } from "bun:test";
import type { MailboxOperationalHealth } from "../../contracts";
import {
  formatHealthEventAge,
  mailboxHealthPresentation,
  mailboxOperationalHealthSummary,
  mailboxOverviewSubtitle,
} from "./mail-health-presentation";

const operationalHealth = {
  mailboxId: "00000000-0000-4000-8000-000000000001",
  health: "degraded",
  healthReason: "Failed to establish connection in required time",
  syncEnabled: true,
  bindings: { total: 1, active: 1, degraded: 0, pending: 0, revoked: 0, lastVerifiedAt: null, rightsSources: {} },
  discovery: {
    generation: 1,
    lastAt: "2026-08-09T12:00:00.000Z",
    activeFolders: 7,
    missingFolders: 1,
    ambiguousFolders: 0,
    subscribedFolders: 7,
  },
  sync: {
    lastAt: "2026-08-09T12:00:00.000Z",
    lagSeconds: 840,
    runningRuns: 0,
    failedRuns: 1,
    folderStates: { degraded: 6, current: 1 },
  },
  hydration: { complete: 80, pending: 0, failed: 0 },
  commands: { states: { failed: 1 }, maintenanceQueued: 0 },
  outbox: { states: {} },
  search: { configuredBackend: "auto", pgTextsearchInstalled: false, bm25Ready: false },
} satisfies MailboxOperationalHealth;

describe("mailbox health presentation", () => {
  test("explains a transient connection timeout without blaming saved settings", () => {
    const presentation = mailboxHealthPresentation({
      health: "degraded",
      healthReason: "Failed to establish connection in required time",
    });

    expect(presentation).toMatchObject({
      title: "Mail is taking longer to connect",
      action: "health",
      actionLabel: "View status",
    });
    expect(presentation?.message).toContain("saved account is valid");
    expect(presentation?.message).not.toContain("Failed to establish");
  });

  test("directs authentication failures to delivery settings", () => {
    expect(mailboxHealthPresentation({ health: "auth_required", healthReason: "invalid credentials" })).toMatchObject({
      action: "delivery",
      actionLabel: "Reconnect account",
    });
  });

  test("localizes visible health text for German, de-CH, and unknown-locale fallback", () => {
    const mailbox = { health: "auth_required" as const, healthReason: "invalid credentials" };
    expect(mailboxHealthPresentation(mailbox, "de")).toMatchObject({
      title: "Erneute Anmeldung erforderlich",
      actionLabel: "Konto erneut verbinden",
    });
    expect(mailboxHealthPresentation(mailbox, "de-CH")?.message).toContain("Verbinde das Konto erneut");
    expect(mailboxHealthPresentation(mailbox, "fr")?.title).toBe("Mail needs you to sign in again");
  });

  test("localizes the missing receiving address and its health title", () => {
    const mailbox = { health: "paused" as const, healthReason: null, receivingAddress: null };
    expect(mailboxOverviewSubtitle(mailbox, "de-CH")).toBe("Keine Empfangsadresse konfiguriert · E-Mail-Synchronisierung ist pausiert");
    expect(mailboxOverviewSubtitle(mailbox, "fr")).toBe("No receiving address configured · Mail sync is paused");
  });

  test("keeps transitional states informative and active mailboxes quiet", () => {
    expect(mailboxHealthPresentation({ health: "reconnecting", healthReason: null })?.tone).toBe("info");
    expect(mailboxHealthPresentation({ health: "active", healthReason: null })).toBeNull();
    expect(mailboxHealthPresentation({ health: "paused", healthReason: null })?.message).toContain("resumed");
  });

  test("names the affected health areas from the existing operational snapshot", () => {
    expect(mailboxOperationalHealthSummary(operationalHealth)).toEqual({
      accounts: "1 connected account",
      discovery: "7 discovered folders · 1 needs review",
      synchronization: "6 degraded folders · 1 current folder",
      search: "Search available · standard",
    });
  });

  test("localizes operational summaries through the de-CH parent locale", () => {
    expect(mailboxOperationalHealthSummary(operationalHealth, "de-CH")).toEqual({
      accounts: "1 verbundenes Konto",
      discovery: "7 erkannte Ordner · 1 muss geprüft werden",
      synchronization: "6 beeinträchtigte Ordner · 1 aktueller Ordner",
      search: "Suche verfügbar · standard",
    });
  });

  test("keeps setup states explicit instead of reporting zero current folders", () => {
    expect(
      mailboxOperationalHealthSummary({
        ...operationalHealth,
        health: "bootstrapping",
        bindings: { ...operationalHealth.bindings, active: 0, pending: 1 },
        discovery: { ...operationalHealth.discovery, activeFolders: 0, missingFolders: 0 },
        sync: { ...operationalHealth.sync, folderStates: { pending: 3 } },
      }),
    ).toMatchObject({
      accounts: "1 account pending",
      discovery: "0 discovered folders",
      synchronization: "3 folders pending",
    });
    expect(
      mailboxOperationalHealthSummary(
        {
          ...operationalHealth,
          bindings: { ...operationalHealth.bindings, active: 0, pending: 1 },
        },
        "de",
      ).accounts,
    ).toBe("1 ausstehendes Konto");
  });

  test("shows elapsed attention age instead of a weekday or opaque date", () => {
    const base = new Date("2026-08-09T16:00:00.000Z");
    expect(formatHealthEventAge("2026-08-09T15:46:00.000Z", base)).toBe("14 minutes ago");
    expect(formatHealthEventAge("2026-08-07T16:00:00.000Z", base)).toBe("2 days ago");
    expect(formatHealthEventAge("2026-07-18T16:00:00.000Z", base)).toBe("22 days ago");
    expect(formatHealthEventAge("2026-08-09T15:46:00.000Z", base, "de-CH")).toBe("vor 14 Minuten");
    expect(formatHealthEventAge("2026-08-09T15:46:00.000Z", base, "fr")).toBe("14 minutes ago");
  });
});

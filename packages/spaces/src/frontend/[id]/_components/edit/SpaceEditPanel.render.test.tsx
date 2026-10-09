import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { AccessEntry, SpaceColumn, SpaceDetail } from "@/contracts";

const root = mkdtempSync(join(tmpdir(), "spaces-settings-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: SpaceEditPanel } = await import("./SpaceEditPanel.tsx");
const { StatusesSection } = await import("./StatusesSection.tsx");
const { TemplatesSection } = await import("./TemplatesSection.tsx");
const { PermissionsSection } = await import("./AccessSection.tsx");
const { spaceMessages } = await import("../../messages.ts");
const { LocaleProvider } = await import("@k2b/ui");

const spaceId = "Space1";
const columns: SpaceColumn[] = [
  {
    id: "Col001",
    spaceId,
    name: "Open",
    color: "#2563eb",
    rank: "1024",
    isDone: false,
  },
  {
    id: "Col002",
    spaceId,
    name: "Done",
    color: "#16a34a",
    rank: "2048",
    isDone: true,
  },
];
const space: SpaceDetail = {
  id: spaceId,
  name: "Launch",
  description: "Release planning",
  color: "#6366f1",
  icalToken: "calendar-token",
  createdAt: "2026-08-10T10:00:00.000Z",
  updatedAt: "2026-08-10T10:00:00.000Z",
  columns,
  virtualColumns: [],
  tags: [],
  templates: [],
};

const renderSettings = (permission: "read" | "admin", locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(SpaceEditPanel, {
          space,
          baseUrl: "https://cloud.example.test",
          initialSettings: { view: "list", hideSettings: false },
          accessEntries: [],
          apiKeys: [],
          wormholes: [],
          isAdmin: permission === "admin",
          canWrite: permission === "admin",
          onClose: () => undefined,
        });
      },
    }),
  );

describe("Spaces settings", () => {
  test("has a complete German catalog with regional fallback", () => {
    expect(spaceMessages.check()).toEqual([]);
    expect(spaceMessages.resolve(["de-CH"]).locale).toBe("de");
    expect(spaceMessages.resolve(["de-CH"]).t.spaceSettings).toBe("Space-Einstellungen");
  });

  test("renders grouped admin navigation and the shared save footer", () => {
    const html = renderSettings("admin");

    expect(html).toContain('aria-label="Space settings sections"');
    expect(html).toContain("Space");
    expect(html).toContain("Personal");
    expect(html).toContain("Connections");
    expect(html).toContain("Sharing");
    expect(html).toContain("Lifecycle");
    expect(html).toContain("General");
    expect(html).toContain("Tags");
    expect(html).toContain("Statuses");
    expect(html).toContain("Templates");
    expect(html).toContain("Defaults");
    expect(html).toContain("Wormholes");
    expect(html).toContain("Access");
    expect(html).toContain("API keys");
    expect(html).toContain("Danger zone");
    expect(html).toContain('class="k2b-settings-group"');
    expect(html).toContain('class="k2b-settings__footer"');
    expect(html).toContain("No unsaved changes");
  });

  test("keeps read access focused on personal defaults and the calendar feed", () => {
    const html = renderSettings("read");

    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html).toContain("Personal");
    expect(html).toContain("Defaults");
    expect(html).toContain("Connections");
    expect(html).toContain("Calendar");
    expect(html).toContain("Stored in this browser and applied immediately.");
    expect(html).not.toContain("Sharing");
    expect(html).not.toContain("Danger zone");
  });

  test("lists task and event templates with their date rule; only admins see the tab", () => {
    const template = {
      id: "Tpl001",
      spaceId,
      kind: "task" as const,
      name: "Weekly report",
      title: "Weekly report {{week}}",
      description: null,
      priority: null,
      tags: [],
      assignees: [],
      assignCreator: false,
      checklist: [],
      estimatedDurationMinutes: null,
      location: null,
      url: null,
      allDay: false,
      durationMinutes: null,
      timeOfDay: null,
      dateRule: { type: "weekdays" as const, weekdays: ["WE" as const, "TH" as const] },
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    const html = renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "de",
        get children() {
          return createComponent(TemplatesSection, { spaceId, templates: [template], tags: [], onDirtyChange: () => undefined });
        },
      }),
    );
    expect(html).toContain("Aufgabenvorlagen");
    expect(html).toContain("Terminvorlagen");
    expect(html).toContain("Weekly report");
    expect(html).toContain("Mi oder Do · 17:00");
    expect(html).toContain("Noch keine Terminvorlagen.");
    expect(html).toContain('aria-label="Vorlage bearbeiten: Weekly report"');
    expect(renderSettings("read")).not.toContain("Templates");
  });

  test("renders statuses as a semantic settings collection", () => {
    const html = renderToString(() =>
      createComponent(StatusesSection, { spaceId, columns, virtualColumns: [], onDirtyChange: () => undefined }),
    );

    expect(html).toContain('class="k2b-settings-collection"');
    expect(html).toContain('class="k2b-settings-collection__list"');
    expect(html).toContain("Workflow statuses");
    expect(html).toContain("Position 1 of 2");
    expect(html).toContain('aria-label="Edit Open"');
    expect(html).toContain('aria-label="Move Done down"');
    expect(html).toContain("Automatic columns");
  });

  test("orders an enabled automatic column among the statuses, without edit or delete", () => {
    const html = renderToString(() =>
      createComponent(StatusesSection, {
        spaceId,
        columns,
        virtualColumns: [{ kind: "blocked", rank: "1536" }],
        onDirtyChange: () => undefined,
      }),
    );

    // The automatic-column switches above the list name the same columns; the order is the list's.
    const list = html.slice(html.indexOf("k2b-settings-collection__list"));
    const order = ["Open", "Blocked", "Done"].map((title) => list.indexOf(`>${title}<`));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order.every((position, index) => position > (order[index - 1] ?? -1))).toBe(true);
    expect(html).toContain("Automatic column · Position 2 of 3");
    expect(html).toContain('aria-label="Move Blocked up"');
    expect(html).not.toContain('aria-label="Edit Blocked"');
    expect(html).not.toContain('aria-label="Delete Blocked"');
  });

  test("renders German settings through the inherited locale", () => {
    const html = renderSettings("admin", "de-CH");

    expect(html).toContain('aria-label="Bereiche von Space-Einstellungen"');
    expect(html).toContain("Persönlich");
    expect(html).toContain("Verbindungen");
    expect(html).toContain("Freigabe");
    expect(html).toContain("Gefahrenbereich");
    expect(html).toContain("Allgemeine Angaben");
    expect(html).toContain("Keine ungespeicherten Änderungen");
    expect(html).not.toContain("Danger zone");
  });
});

describe("Spaces settings: Access", () => {
  const manager = (
    id: string,
    principal: AccessEntry["principal"],
    displayName: string,
    extra: Partial<AccessEntry> = {},
  ): AccessEntry => ({
    id,
    principal,
    permission: "admin",
    displayName,
    createdAt: "2026-08-10T10:00:00.000Z",
    ...extra,
  });
  const person = manager("access-person", { type: "user", userId: "user-1" }, "Ada Lovelace");
  const agent = manager("access-agent", { type: "service_account", serviceAccountId: "agent-1" }, "Triage agent", {
    serviceAccountKind: "agent",
  });
  const apiKey = manager("access-key", { type: "service_account", serviceAccountId: "key-1" }, "Launch API keys", {
    serviceAccountKind: "resource_bound",
  });
  const renderAccess = (accessEntries: AccessEntry[]) =>
    renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "en",
        get children() {
          return createComponent(PermissionsSection, { spaceId, accessEntries });
        },
      }),
    );
  // The editor marks the only manager's remove button with the reason it cannot be removed.
  const lockedRows = (html: string) => html.match(/aria-description=/g)?.length ?? 0;

  test("shows an agent that manages the space, so a person managing next to it is not locked", () => {
    const html = renderAccess([person, agent, apiKey]);

    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Triage agent");
    expect(html).toContain("(Agent)");
    expect(lockedRows(html)).toBe(0);
  });

  test("keeps API keys in their own section and does not count them as managers", () => {
    const html = renderAccess([person, apiKey]);

    expect(html).not.toContain("Launch API keys");
    expect(lockedRows(html)).toBe(1);
  });
});

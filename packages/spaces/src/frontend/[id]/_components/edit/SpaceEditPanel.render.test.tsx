import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { SpaceColumn, SpaceDetail } from "@/contracts";

const root = mkdtempSync(join(tmpdir(), "spaces-settings-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: SpaceEditPanel } = await import("./SpaceEditPanel.tsx");
const { StatusesSection } = await import("./StatusesSection.tsx");
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
  tags: [],
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

  test("renders statuses as a semantic settings collection", () => {
    const html = renderToString(() => createComponent(StatusesSection, { spaceId, columns, onDirtyChange: () => undefined }));

    expect(html).toContain('class="k2b-settings-collection"');
    expect(html).toContain('class="k2b-settings-collection__list"');
    expect(html).toContain("Workflow statuses");
    expect(html).toContain("Position 1 of 2");
    expect(html).toContain('aria-label="Edit Open"');
    expect(html).toContain('aria-label="Move Done down"');
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

import { describe, expect, test } from "bun:test";
import { LocaleProvider } from "@k2b/ui";
import { renderToString } from "solid-js/web";
import type { InventoryEntry } from "../src/contracts";
import AdminHistory from "../src/frontend/AdminHistory";
import AdminIssue from "../src/frontend/AdminIssue";
import { parseAdminLocation } from "../src/frontend/admin-location";
import FilesScreen from "../src/frontend/FilesScreen.island";
import FileThumbnail from "../src/frontend/FileThumbnail";
import { DirectoryStatus, IssueMessage } from "../src/frontend/feedback";
import Inventory from "../src/frontend/Inventory";
import Workspace from "../src/frontend/Workspace.island";
import { chain, current, entry, gone } from "./history-fixtures";

describe("Filesv2 server-rendered feedback", () => {
  test("an old folder SSR snapshot shows its move without a false loading error", () => {
    const base = {
      id: "cloud:groups:team",
      area: "cloud" as const,
      kind: "groups" as const,
      name: "Team",
      status: "existing" as const,
      reason: null,
      indexEnabled: true,
      versioningEnabled: true,
    };
    const moved = entry({ action: "item.move", before: gone("team/Old"), after: current("team/New") });
    const html = renderToString(() => (
      <LocaleProvider locale="en">
        <Workspace
          timeZone="Europe/Berlin"
          initial={{
            source: `/app/filesv2?base=${encodeURIComponent(base.id)}&path=Old`,
            bases: { items: [base], issues: [], editor: null },
            selectedId: base.id,
            directory: null,
            errorCode: null,
            now: "2026-10-20T12:30:00.000Z",
            moved: {
              baseId: base.id,
              path: "Old",
              entry: moved,
              chain: chain({ endpoint: { baseId: base.id, path: "New", itemId: null }, certainty: "verified" }),
            },
          }}
        />
      </LocaleProvider>
    ));
    expect(html).toContain("This folder has moved");
    expect(html).not.toContain("Files could not be loaded");
    expect(html).not.toContain("Try again");
  });

  test("all inventory states have readable localized labels independent of color", () => {
    const html = renderToString(() => (
      <LocaleProvider locale="de">
        <DirectoryStatus status="existing" />
        <DirectoryStatus status="missing" />
        <DirectoryStatus status="unassigned" />
        <DirectoryStatus status="conflict" />
        <DirectoryStatus status="unknown" />
        <DirectoryStatus status="orphaned" />
        <DirectoryStatus status="retired" />
      </LocaleProvider>
    ));
    for (const label of ["Vorhanden", "Fehlt", "Nicht zugeordnet", "Konflikt", "Unbekannt", "Verwaist", "Stillgelegt"])
      expect(html).toContain(label);
  });

  test("disabled, missing and inaccessible storage cannot render as an empty directory", () => {
    const html = renderToString(() => (
      <LocaleProvider locale="en">
        <IssueMessage code="local_linux_disabled" />
        <IssueMessage code="not_found" />
        <IssueMessage code="unavailable" />
      </LocaleProvider>
    ));
    expect(html).toContain("Personal and group Cloud storage requires local Linux identities");
    expect(html).toContain("This directory is missing");
    expect(html).toContain("Storage is currently unavailable");
    expect(html).not.toContain("This folder is empty");
  });
  test("admin failures give actionable guidance without referring to another administrator", () => {
    const html = renderToString(() => (
      <LocaleProvider locale="en">
        <AdminIssue code="not_found" />
        <AdminIssue code="unavailable" />
        <AdminIssue code="identity_unknown" />
      </LocaleProvider>
    ));
    expect(html).toContain("This directory has not been created yet");
    expect(html).toContain("Check the connection");
    expect(html).not.toContain("Contact your administrator");
  });
  test("directory names show the display name above the username and mark missing owners", () => {
    const row = (name: string, displayName: string | null, kind: InventoryEntry["kind"] = "users"): InventoryEntry => ({
      identityId: displayName === null ? null : `${name}-id`,
      name,
      displayName,
      path: `${kind}/${name}`,
      kind,
      area: "cloud",
      status: "existing",
      reason: null,
      baseId: null,
      operationId: null,
      uid: null,
      gid: null,
      actions: { create: false, adopt: false, archive: false, browse: true, delete: false, retire: false },
    });
    const items = [row("qdt", "Quinn Doe"), row("ghost", null), row("team", "team", "groups"), row("gone", null, "groups")];
    const render = (locale: "en" | "de") =>
      renderToString(() => (
        <LocaleProvider locale={locale}>
          <Inventory
            items={items}
            location={parseAdminLocation("/admin/filesv2?view=directories")}
            busy={false}
            onAction={() => {}}
            onNavigate={async () => {}}
          />
        </LocaleProvider>
      ));
    const en = render("en");
    expect(en).toMatch(/Quinn Doe[\s\S]*font-mono[^>]*>qdt</);
    expect(en).toContain("Unknown account");
    expect(en).toContain("Unknown group");
    expect(en.match(/font-mono[^>]*>team</)).toBeNull();
    const de = render("de");
    expect(de).toContain("Quinn Doe");
    expect(de).toContain("Unbekanntes Konto");
    expect(de).toContain("Unbekannte Gruppe");
  });
  test("a folder renders on v2 with its rows, its path and the open entry, and no loading state on the first picture", () => {
    const base = {
      id: "cloud:groups:team",
      area: "cloud" as const,
      kind: "groups" as const,
      name: "Team",
      status: "existing" as const,
      reason: null,
      indexEnabled: true,
      versioningEnabled: false,
    };
    const item = (path: string, directory: boolean, size = 0) => ({
      name: path.split("/").at(-1)!,
      path,
      directory,
      size,
      modified: "2026-11-20T09:15:00.000Z",
      actions: { write: true, move: true, share: true },
    });
    const items = [item("Projects/Drafts", true), item("Projects/Budget 2027.xlsx", false, 48_213), item("Projects/Notes.md", false, 912)];
    const html = renderToString(() => (
      <LocaleProvider locale="en">
        <FilesScreen
          timeZone="Europe/Berlin"
          initial={{
            source: `/app/filesv2?base=${encodeURIComponent(base.id)}&path=Projects&file=Projects%2FNotes.md`,
            bases: { items: [base], issues: [], editor: null },
            selectedId: base.id,
            directory: { base, path: "Projects", items, next: null, actions: { create: true } },
            detail: { base, entry: items[2]!, favorite: false },
            errorCode: null,
            now: "2026-11-25T12:00:00.000Z",
          }}
        />
      </LocaleProvider>
    ));
    for (const text of ["Drafts", "Budget 2027.xlsx", "Notes.md", "Projects", "Upload", "3 items loaded"]) expect(html).toContain(text);
    expect(html).toContain('data-k2-part="Workspace"');
    expect(html).toContain('data-k2-part="Table"');
    expect(html).toContain('data-k2-part="Path"');
    expect(html).toContain('data-k2-part="FilterBar"');
    // The open entry stands beside the list from the first picture, with its deeds and properties.
    expect(html).toContain("Properties");
    expect(html).toContain("Download");
    // Zero loading indicators on the first render (quality bar of the v2 migration).
    expect(html).not.toContain('data-k2-part="Loading"');
    // The folder moves in place: every row is a real link with the folder or the open entry in its address.
    expect(html).toContain("path=Projects%2FDrafts");
    expect(html).toContain("file=Projects%2FBudget+2027.xlsx");
  });
});

test("the administration history renders its authorized first page as table and list on the server", () => {
  const binding = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const filters = { when: "30" as const };
  const html = renderToString(() => (
    <LocaleProvider locale="de">
      <AdminHistory
        env={{ now: "2026-10-20T12:30:00.000Z", timeZone: "Europe/Berlin" }}
        filters={filters}
        onFiltersChange={() => {}}
        bases={{ items: [], next: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }}
        baseLabels={[
          {
            id: "cloud:groups:11111111-1111-4111-8111-111111111111",
            bindingId: binding,
            area: "cloud",
            kind: "groups",
            name: "vertrieb",
            displayName: "Team Vertrieb",
            root: "cloud",
            path: "groups/vertrieb",
          },
        ]}
        loadBases={async () => {
          throw new Error("SSR must use its authorized metadata snapshot");
        }}
        initial={{
          filters,
          page: {
            items: [
              {
                id: "00000000-0000-4000-8000-000000000001",
                action: "file.overwrite",
                state: "done",
                time: "2026-10-20T06:52:00.000Z",
                startedAt: "2026-10-20T06:52:00.000Z",
                finishedAt: "2026-10-20T06:52:00.000Z",
                actor: { kind: "user", userId: "33333333-3333-4333-8333-333333333333", name: "Mia Schulz" },
                via: "office",
                before: { visibility: "hidden" },
                after: {
                  visibility: "full",
                  source: "snapshot",
                  name: "Proof_Visitenkarten.pdf",
                  path: "groups/vertrieb/Proof_Visitenkarten.pdf",
                  root: "cloud",
                  baseId: binding,
                  publicBaseId: null,
                  itemId: null,
                  directory: false,
                  size: 3_400_000,
                  revision: null,
                },
                batchId: null,
              },
            ],
            next: null,
            visibleCount: 1,
            batches: [],
            exhausted: true,
            scanLimitReached: false,
            searchLimitReached: false,
          },
        }}
        load={() => new Promise(() => {})}
      />
    </LocaleProvider>
  ));
  for (const text of [
    "Zeit",
    "Ablage",
    "Weg",
    "20.10. 08:52",
    "Überschrieben",
    "Proof_Visitenkarten.pdf",
    "Team Vertrieb",
    "Office-Editor",
  ])
    expect(html).toContain(text);
  expect(html).toContain("filesv2-history-row");
  expect(html).not.toContain("Aktivität wird geladen");
});

test("folders and files without a preview use file-type tiles at row, grid and hero sizes", () => {
  for (const [name, directory, type] of [
    ["Projects", true, "folder"],
    ["archive.zip", false, "archive"],
  ] as const) {
    for (const mode of ["row", "grid", "hero"] as const) {
      const html = renderToString(() => (
        <FileThumbnail
          baseId="demo"
          entry={{ name, path: name, directory, size: 12, modified: "2026-01-01T00:00:00Z" }}
          large={mode === "grid"}
          hero={mode === "hero"}
        />
      ));
      expect(html).toContain("filesv2-thumbnail");
      expect(html).toContain("k2b-icon-tile k2b-file-type-icon");
      expect(html).toContain(`data-file-type="${type}"`);
      expect(html).toContain(`data-size="${mode === "row" ? "md" : "lg"}"`);
      expect(html).not.toContain("<img");
    }
  }
});

test("a photo or PDF puts its versioned preview address into the first HTML, small in rows and tiles, large as the hero", () => {
  for (const name of ["report.pdf", "photo.png"]) {
    for (const mode of ["row", "grid", "hero"] as const) {
      const html = renderToString(() => (
        <FileThumbnail
          baseId="demo"
          entry={{ name, path: `Team/${name}`, directory: false, size: 12, modified: "2026-01-01T00:00:00Z", revision: "r7" }}
          large={mode === "grid"}
          hero={mode === "hero"}
        />
      ));
      const size = mode === "hero" ? "large" : "small";
      expect(html).toContain(`src="/api/filesv2/bases/demo/preview?path=Team%2F${name}&amp;rev=r7&amp;size=${size}"`);
      expect(html).toContain('loading="lazy"');
      // The box holds its place before the preview arrives: no icon first, so nothing swaps in a cached preview.
      expect(html).not.toContain("k2b-file-type-icon");
    }
  }
});

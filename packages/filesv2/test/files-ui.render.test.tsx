import { describe, expect, test } from "bun:test";
import { createCollectionSelection, LocaleProvider } from "@k2b/ui";
import { renderToString } from "solid-js/web";
import type { InventoryEntry } from "../src/contracts";
import AdminIssue from "../src/frontend/AdminIssue";
import { parseAdminLocation } from "../src/frontend/admin-location";
import FileList, { type FileRow } from "../src/frontend/FileList";
import { DirectoryStatus, IssueMessage } from "../src/frontend/feedback";
import Inventory from "../src/frontend/Inventory";

describe("Filesv2 server-rendered feedback", () => {
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
    expect(html).toContain("Cloud files require local Linux identities");
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
  test("a deep-linked entry renders as the active row like the tree's current folder, a checked row does not", () => {
    const entry = (path: string, directory: boolean, extra: Partial<FileRow> = {}): FileRow => ({
      name: path.split("/").at(-1)!,
      path,
      directory,
      size: directory ? 0 : 12,
      modified: "2026-01-01T00:00:00Z",
      ...extra,
    });
    const messages = {
      name: "Name",
      size: "Size",
      modified: "Modified",
      details: String,
      toggle: String,
      select: String,
      more: "More",
      up: "Up",
    };
    const render = (props: { rows: FileRow[]; selected: string[]; tree?: boolean; currentPath?: string; selecting?: boolean }) =>
      renderToString(() => {
        const selection = createCollectionSelection({ ids: () => props.rows.map((row) => row.path), initial: props.selected });
        return (
          <LocaleProvider locale="en">
            <FileList
              {...props}
              baseId="demo"
              selection={selection}
              label="Files"
              showModified={false}
              messages={messages}
              onOpen={() => {}}
              onDetails={() => {}}
            />
          </LocaleProvider>
        );
      });
    // Each row's markup up to the next row; its opening tag carries the state classes and ARIA attributes.
    const row = (html: string, path: string) => html.split('<div role="row"').find((chunk) => chunk.includes(`title="${path}"`))!;
    const tag = (chunk: string) => chunk.slice(0, chunk.indexOf(">"));
    const flat = [entry("Drafts", true), entry("Notes.md", false)];

    const list = render({ rows: flat, selected: ["Drafts"] });
    expect(tag(row(list, "Drafts"))).toContain("filesv2-list__row--active");
    expect(tag(row(list, "Drafts"))).toContain('aria-selected="true"');
    expect(row(list, "Drafts")).toContain("ti-folder-open");
    expect(tag(row(list, "Notes.md"))).not.toContain("filesv2-list__row--active");

    const selecting = render({ rows: flat, selected: ["Drafts"], selecting: true });
    expect(tag(row(selecting, "Drafts"))).toContain('aria-selected="true"');
    expect(tag(row(selecting, "Drafts"))).not.toContain("filesv2-list__row--active");
    expect(row(selecting, "Drafts")).not.toContain("ti-folder-open");

    const tree = render({
      rows: [entry("Projects", true, { depth: 0, expanded: true }), entry("Projects/Drafts", true, { depth: 1 })],
      selected: [],
      tree: true,
      currentPath: "Projects",
    });
    expect(tag(row(tree, "Projects"))).toContain("filesv2-list__row--active");
    expect(tag(row(tree, "Projects"))).toContain('aria-current="location"');
    expect(tag(row(tree, "Projects/Drafts"))).not.toContain("filesv2-list__row--active");
  });
});

import { describe, expect, test } from "bun:test";
import { renderToString } from "solid-js/web";
import type { Notebook } from "../sidebar/types";
import "../detail/ssr-test-plugin";

const { NotebookSettingsBody } = await import("./NotebookSettingsPanel.tsx");
const { DefaultPresentationSection } = await import("./FeaturesSection.tsx");

const notebook: Notebook = {
  id: "notes1",
  name: "Research",
  description: "Shared research notes",
  icon: "ti ti-flask",
  homepageNoteId: null,
  scriptsEnabled: false,
  defaultPresentationMode: "write",
  defaultNoteTitleTemplate: "{{ date }}",
  createdBy: "user-id",
  createdAt: "2026-08-10T10:00:00.000Z",
  updatedAt: "2026-08-10T10:00:00.000Z",
};

const renderSettings = (isAdmin: boolean) =>
  renderToString(() => (
    <NotebookSettingsBody
      notebook={notebook}
      tree={[]}
      isAdmin={isAdmin}
      canWrite={isAdmin}
      dateConfig={{ locale: "en", timeZone: "Europe/Berlin" }}
      close={() => undefined}
    />
  ));

describe("Notebook settings", () => {
  test("uses the shared selector and explains the reader-only Book restriction", () => {
    const html = renderToString(() => <DefaultPresentationSection notebook={notebook} isAdmin onNotebookChange={() => undefined} />);
    expect(html).toContain('aria-label="Default view"');
    expect(html).toContain("Readers always use Book");
    expect(html).toContain('role="combobox"');
    expect(html).toContain("Write");
    expect(html).not.toContain("disabled");
  });

  test("disables the shared default view setting for non-admins", () => {
    const html = renderToString(() => (
      <DefaultPresentationSection
        notebook={{ ...notebook, defaultPresentationMode: "book" }}
        isAdmin={false}
        onNotebookChange={() => undefined}
      />
    ));
    expect(html).toContain('aria-label="Default view"');
    expect(html).toContain("disabled");
    expect(html).toContain("Book");
  });

  test("renders grouped admin navigation and the shared save footer", () => {
    const html = renderSettings(true);

    expect(html).toContain('aria-label="Notebook settings sections"');
    expect(html).toContain("Notebook");
    expect(html).toContain("Sharing");
    expect(html).toContain("Data");
    expect(html).toContain("Lifecycle");
    expect(html).toContain("View &amp; behavior");
    expect(html).toContain("Access");
    expect(html).toContain("API keys");
    expect(html).toContain("Export &amp; snapshots");
    expect(html).toContain("Danger zone");
    expect(html).toContain('class="k2b-settings-group"');
    expect(html).toContain('class="k2b-settings__footer"');
    expect(html).toContain("No unsaved changes");
  });

  test("keeps read-only settings focused on visible notebook preferences", () => {
    const html = renderSettings(false);

    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html).toContain("General");
    expect(html).toContain("View &amp; behavior");
    expect(html).not.toContain("Sharing");
    expect(html).not.toContain("Export &amp; snapshots");
    expect(html).not.toContain("Danger zone");
    expect(html).not.toContain('class="k2b-settings__footer"');
  });
});

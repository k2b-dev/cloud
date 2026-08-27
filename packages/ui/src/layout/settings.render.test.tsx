import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-settings-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const {
  readSettingsError,
  sameSettingValue,
  SettingsCollection,
  SettingsField,
  SettingsGroup,
  SettingsModal,
  SettingsPage,
  SettingsPanelFooter,
  SettingsSaveBar,
  SettingsSection,
  TextInput,
} = await import("../index");

describe("@k2b/ui complete settings surfaces", () => {
  test("renders a flat full-page settings shell", () => {
    const html = renderToString(() =>
      createComponent(SettingsPage, {
        title: "AI providers",
        subtitle: "Models and credentials",
        icon: "ti ti-sparkles",
        actions: "toolbar",
        footer: "save controls",
        scrollPreserveKey: "providers",
        children: "provider cards",
      }),
    );

    expect(html).toContain('class="k2b-settings-page"');
    expect(html).toContain("<h1>AI providers</h1>");
    expect(html).toContain("Models and credentials");
    expect(html).toContain('data-scroll-preserve="providers"');
    expect(html).toContain("provider cards");
    expect(html).toContain("save controls");
    expect(html).not.toContain("k2b-panel-dialog");
  });

  test("renders an accessible controlled tab surface", () => {
    const html = renderToString(() =>
      createComponent(SettingsModal, {
        title: "Application settings",
        activeTab: "security",
        children: [
          createComponent(SettingsModal.Tab, {
            id: "general",
            title: "General",
            children: "General content",
          }),
          createComponent(SettingsModal.Tab, {
            id: "security",
            title: "Security",
            description: "Authentication controls",
            icon: "ti ti-lock",
            tone: "danger",
            children: "Security content",
          }),
        ],
      }),
    );

    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain("Security content");
    expect(html).not.toContain("General content");
  });

  test("groups modal navigation and keeps the active panel footer outside the scroll body", () => {
    const html = renderToString(() =>
      createComponent(SettingsModal, {
        title: "Mailbox settings",
        activeTab: "general",
        children: [
          createComponent(SettingsModal.Group, {
            title: "Personal",
            children: createComponent(SettingsModal.Tab, {
              id: "preferences",
              title: "Preferences",
              children: "Personal settings",
            }),
          }),
          createComponent(SettingsModal.Group, {
            title: "Mailbox",
            children: createComponent(SettingsModal.Tab, {
              id: "general",
              title: "General",
              children: ["Mailbox settings", createComponent(SettingsModal.Footer, { children: "Save controls" })],
            }),
          }),
        ],
      }),
    );

    expect(html).toContain('class="k2b-settings__tab-group"');
    expect(html).toContain("Personal");
    expect(html).toContain("Mailbox");
    expect(html).toContain("Mailbox settings");
    expect(html).toContain('<footer class="k2b-settings__footer">Save controls</footer>');
    expect(html).not.toContain("Personal settings");
  });

  test("resolves invalid requested tabs to the first tab", () => {
    const html = renderToString(() =>
      createComponent(SettingsModal, {
        title: "Application settings",
        activeTab: "missing",
        children: [
          createComponent(SettingsModal.Tab, { id: "general", title: "General", children: "General content" }),
          createComponent(SettingsModal.Tab, { id: "security", title: "Security", children: "Security content" }),
        ],
      }),
    );

    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("General content");
    expect(html).not.toContain("Security content");
  });

  test("rejects invalid and duplicate tab ids", () => {
    expect(() =>
      renderToString(() =>
        createComponent(SettingsModal, {
          title: "Application settings",
          children: createComponent(SettingsModal.Tab, { id: "not safe", title: "General", children: "General" }),
        }),
      ),
    ).toThrow("SettingsModal.Tab id must start with a letter");

    expect(() =>
      renderToString(() =>
        createComponent(SettingsModal, {
          title: "Application settings",
          children: [
            createComponent(SettingsModal.Tab, { id: "general", title: "General", children: "General" }),
            createComponent(SettingsModal.Tab, { id: "general", title: "Again", children: "Again" }),
          ],
        }),
      ),
    ).toThrow('duplicate id "general"');
  });

  test("separates full-page settings sections from dialog sections", () => {
    const html = renderToString(() =>
      createComponent(SettingsSection, {
        title: "Identity",
        subtitle: "Workspace name and URL",
        icon: "ti ti-id",
        actions: "section action",
        children: "settings fields",
      }),
    );

    expect(html).toContain('class="k2b-settings-section"');
    expect(html).toContain(">Identity</h2>");
    expect(html).toMatch(/aria-labelledby="k2b-settings-section-[^"]+"/);
    expect(html).toContain("Workspace name and URL");
    expect(html).toContain("section action");
    expect(html).not.toContain("k2b-panel-dialog");
  });

  test("composes flat settings groups and entity collections through named slots", () => {
    const group = renderToString(() =>
      createComponent(SettingsGroup, {
        title: "Reading",
        description: "Message display defaults",
        children: [
          createComponent(SettingsGroup.Action, { children: "Reset reading" }),
          createComponent(SettingsField, {
            label: "Message format",
            description: "Choose the preferred representation",
            error: undefined,
            children: "format control",
          }),
        ],
      }),
    );
    const collection = renderToString(() =>
      createComponent(SettingsCollection, {
        title: "Saved views",
        description: "Reusable filters",
        empty: "No saved views yet",
        children: [
          createComponent(SettingsCollection.Action, { children: "New view" }),
          createComponent(SettingsCollection.Item, {
            title: "Open conversations",
            description: "Private view · 3 filters",
            icon: "view icon",
            children: [
              createComponent(SettingsCollection.Item.Status, { children: "Private" }),
              createComponent(SettingsCollection.Item.Actions, {
                children: [
                  createComponent(SettingsCollection.Item.Reorder, {
                    label: "Open conversations",
                    index: 0,
                    count: 2,
                    onMove: () => undefined,
                  }),
                  "Edit view",
                ],
              }),
            ],
          }),
        ],
      }),
    );
    const empty = renderToString(() =>
      createComponent(SettingsCollection, {
        title: "Templates",
        empty: "No templates yet",
      }),
    );

    expect(group).toContain('class="k2b-settings-group"');
    expect(group).toContain("Reset reading");
    expect(group).toContain("format control");
    expect(group).not.toContain("[object Object]");
    expect(collection).toContain('class="k2b-settings-collection__list"');
    expect(collection).toContain("New view");
    expect(collection).toContain("Private");
    expect(collection).toContain("Edit view");
    expect(collection).toContain('aria-label="Move Open conversations up"');
    expect(collection).toContain('aria-label="Move Open conversations down"');
    expect(collection).toMatch(/aria-label="Move Open conversations up"[^>]*disabled/);
    expect(collection).not.toMatch(/aria-label="Move Open conversations down"[^>]*disabled/);
    expect(collection).not.toContain("No saved views yet");
    expect(empty).toContain("No templates yet");
    expect(empty).toContain('data-variant="compact"');
  });

  test("aligns direct group fields with the group heading", () => {
    const css = readFileSync(resolve(import.meta.dir, "../styles/layout-parity.css"), "utf8");
    const directFieldRule = css.match(/\.k2b-ui \.k2b-settings-group__body > \.k2b-settings-field\s*\{([^}]+)\}/)?.[1];
    const fieldRule = css.match(/\.k2b-ui \.k2b-settings-field\s*\{([^}]+)\}/)?.[1];
    const groupHeadingRule = [...css.matchAll(/\.k2b-ui \.k2b-settings-group__heading h3,[^{]+\{([^}]+)\}/g)]
      .map((match) => match[1])
      .find((rule) => rule?.includes("font-size"));
    const footerRule = css.match(/\.k2b-ui \.k2b-settings__footer\s*\{([^}]+)\}/)?.[1];
    const bodyRule = css.match(/\.k2b-ui \.k2b-settings__body\s*\{([^}]+)\}/)?.[1];

    expect(directFieldRule).toContain("padding: 0");
    expect(fieldRule).toContain("min-width: 0");
    expect(groupHeadingRule).toContain("font-size: 1rem");
    expect(footerRule).toContain("background: var(--k2b-surface)");
    expect(bodyRule).toContain("overflow-x: hidden");
    expect(bodyRule).toContain("overflow-y: auto");
  });

  test("renders changed fields and sticky or fixed save controls", () => {
    const field = renderToString(() =>
      createComponent(SettingsField, {
        label: "Endpoint",
        description: "Public service URL",
        changed: () => true,
        error: () => "Invalid URL",
        children: (control) =>
          createComponent(TextInput, { value: "", "aria-label": "Endpoint", "aria-describedby": control.describedBy() }),
      }),
    );
    const bar = renderToString(() =>
      createComponent(SettingsSaveBar, { changeCount: 2, loading: () => false, onDiscard: () => {}, onSave: () => {} }),
    );
    const footer = renderToString(() =>
      createComponent(SettingsPanelFooter, {
        changeCount: 1,
        loading: () => false,
        saveDisabled: () => true,
        onDiscard: () => {},
        onSave: () => {},
        saveVariant: "ai",
      }),
    );

    expect(field).toContain("Unsaved");
    expect(field).toContain('role="alert"');
    const describedBy = field.match(/aria-describedby="([^"]+)"/)?.[1]?.split(" ") ?? [];
    expect(describedBy).toHaveLength(2);
    for (const id of describedBy) expect(field).toContain(`id="${id}"`);
    expect(bar).toContain("2</strong> unsaved changes");
    expect(footer.replaceAll(/<!--.*?-->/g, "")).toContain("1</strong> unsaved change");
    expect(bar).toContain('role="status"');
    expect(bar).toContain('aria-live="polite"');
    expect(footer).toContain('role="status"');
    expect(footer).toContain('aria-live="polite"');
    expect(footer).toContain('data-variant="ai"');
    expect(footer.match(/disabled/g)?.length).toBe(1);

    // Cloud labels the save action with a floppy glyph on both surfaces; the
    // port rendered a bare text button.
    expect(bar).toContain("ti ti-device-floppy");
    expect(footer).toContain("ti ti-device-floppy");
    expect(bar).toContain("Save changes");
    expect(footer).toContain("Save changes");
  });

  test("compares setting values and safely parses API failures", async () => {
    expect(sameSettingValue({ enabled: true }, { enabled: true })).toBe(true);
    expect(sameSettingValue(["a", "b"], ["b", "a"])).toBe(false);

    const parsed = await readSettingsError(
      new Response(JSON.stringify({ message: "Validation failed", errors: { endpoint: "Required" } })),
      "Could not save",
    );
    const fallback = await readSettingsError(new Response("not json"), "Could not save");

    expect(parsed).toEqual({ message: "Validation failed", fields: { endpoint: "Required" } });
    expect(fallback).toEqual({ message: "Could not save", fields: {} });
  });
});

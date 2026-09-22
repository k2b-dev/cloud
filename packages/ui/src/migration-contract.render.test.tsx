import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent, createRoot } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-migration-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const {
  AppOverview,
  createFormState,
  DataPanel,
  NotFoundState,
  PanelDialog,
  panelDialogFixedOptions,
  panelDialogOptions,
  panelDialogWideOptions,
  panelDialogWorkspaceOptions,
  PanelHeader,
  Placeholder,
  toast,
  Tooltip,
} = await import("./index");

describe("@k2b/ui complete Cloud UI migrations", () => {
  test("renders the complete overview composition", () => {
    const html = renderToString(() =>
      createComponent(AppOverview, {
        title: "Notes",
        subtitle: "Shared knowledge",
        icon: "ti ti-note",
        get children() {
          return createComponent(AppOverview.Main, {
            title: "Recent notes",
            description: "Updated today",
            toolbar: "Search",
            get children() {
              return createComponent(AppOverview.EmptyState, {
                title: "No notes",
                description: "Create the first note.",
                icon: "ti ti-note-off",
              });
            },
          });
        },
      }),
    );

    expect(html).toContain("k2b-app-overview__main");
    expect(html).toContain("Recent notes");
    expect(html).toContain("Updated today");
    expect(html).toContain("No notes");
  });

  test("renders the overview page action and card grid", () => {
    const html = renderToString(() =>
      createComponent(AppOverview, {
        title: "Notes",
        subtitle: "3 notebooks",
        icon: "ti ti-note",
        actions: "New notebook",
        get children() {
          return createComponent(AppOverview.Main, {
            title: "Your notebooks",
            get children() {
              return createComponent(AppOverview.Cards, { children: "Notebook cards" });
            },
          });
        },
      }),
    );

    expect(html).toMatch(/<h1 class="k2b-panel-header__title is-large">Notes<\/h1>/);
    expect(html).toMatch(/k2b-panel-header__actions">New notebook</);
    expect(html).toMatch(/<div class="k2b-app-overview__cards ">Notebook cards<\/div>/);
  });

  test("renders panel headers and all data panel states", () => {
    const header = renderToString(() =>
      createComponent(PanelHeader, {
        title: "Requests",
        subtitle: "12 open",
        actions: "Refresh",
        as: "h3",
        size: "md",
      }),
    );
    const error = renderToString(() =>
      createComponent(DataPanel, {
        title: "Requests",
        error: "Backend unavailable",
      }),
    );
    const empty = renderToString(() =>
      createComponent(DataPanel, {
        title: "Requests",
        isEmpty: true,
        empty: "No requests",
      }),
    );

    expect(header).toContain("<h3");
    expect(header).toContain("12 open");
    expect(header).toContain("Refresh");
    expect(error).toContain('role="alert"');
    expect(error).toContain("Backend unavailable");
    expect(empty).toContain("No requests");
  });

  test("renders placeholder state semantics", () => {
    const html = renderToString(() =>
      createComponent(Placeholder, {
        state: "loading",
        surface: "paper",
        variant: "panel",
        title: "Loading notes",
        description: "Fetching the latest content.",
      }),
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-surface="paper"');
    expect(html).toContain("ti ti-loader-2");
  });

  test("renders the full-page not-found action contract", () => {
    const html = renderToString(() =>
      createComponent(NotFoundState, {
        code: "404",
        title: "Page not found",
        description: "The page does not exist.",
        action: { label: "Back home", href: "/" },
      }),
    );

    expect(html).toContain("404");
    expect(html).toContain('href="/"');
    expect(html).toContain("ti ti-home");
  });

  test("renders accessible tooltip markup on the server", () => {
    const html = renderToString(() =>
      createComponent(Tooltip.Anchor, {
        content: "Settings",
        placement: "bottom",
        children: "Open",
      }),
    );

    expect(html).toContain('role="tooltip"');
    expect(html).toContain('popover="manual"');
    expect(html).toContain("Settings");
  });

  test("renders the complete panel dialog composition", () => {
    const html = renderToString(() =>
      createComponent(PanelDialog, {
        surface: "floating",
        get children() {
          return [
            createComponent(PanelDialog.Header, {
              title: "Edit project",
              subtitle: "General settings",
              icon: "ti ti-settings",
              actions: "Save",
              close: () => {},
            }),
            createComponent(PanelDialog.Tabs, {
              options: [
                { value: "general", label: "General", icon: "ti ti-adjustments" },
                { value: "danger", label: "Danger zone", disabled: true },
              ],
              value: () => "general",
              onValueChange: () => {},
            }),
            createComponent(PanelDialog.Body, {
              scrollPreserveKey: "project-settings",
              get children() {
                return createComponent(PanelDialog.Section, {
                  title: "Profile",
                  subtitle: "Visible to everyone",
                  icon: "ti ti-user",
                  actions: "Reset",
                  children: "Fields",
                });
              },
            }),
            createComponent(PanelDialog.Footer, { children: "Cancel Save" }),
          ];
        },
      }),
    );

    expect(html).toContain('data-surface="floating"');
    expect(html).toContain("k2b-panel-dialog__header");
    expect(html).toContain("k2b-panel-dialog__tabs");
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('aria-selected="true"');
    expect(html).not.toContain("aria-pressed");
    expect(html).toContain('data-scroll-preserve="project-settings"');
    expect(html).toContain("k2b-panel-dialog__section");
    expect(html).toContain("k2b-panel-dialog__footer");
    expect(panelDialogOptions.contentClassName).toBe("k2b-panel-dialog-viewport");
    expect(panelDialogWideOptions.panelClassName).toContain("is-wide");
    expect(panelDialogFixedOptions.panelClassName).toContain("is-fixed");
    expect(panelDialogWorkspaceOptions.panelClassName).toContain("is-workspace");
  });

  test("uses required and custom prompt validation and resets form state", () => {
    createRoot((dispose) => {
      const state = createFormState({
        name: {
          type: "text",
          required: true,
          minLength: 3,
          default: "Ada",
          validate: (value: string | undefined) => (value === "x" ? "choose another name" : null),
        },
        count: { type: "number", min: 1, max: 5, default: 2 },
        pin: { type: "pin", length: 4, default: "12" },
        tags: { type: "tags", minTags: 2, maxTags: 3, default: ["ui", "solid"] },
        public: { type: "boolean", default: true },
        note: { type: "info", content: "Not part of the result." },
      } as const);

      expect(state.validateAll()).toBe(true);
      expect(state.errors.pin).toBeUndefined();
      state.updateField("pin", "1234");
      expect(state.validateAll()).toBe(true);
      state.updateField("name", "x");
      expect(state.errors.name).toBe("choose another name");
      state.reset();
      expect(state.values.name).toBe("Ada");
      expect(state.values.pin).toBe("12");
      expect(state.errors.name).toBeUndefined();
      dispose();
    });
  });

  test("returns no-op toast handles without a DOM", () => {
    expect(globalThis.document).toBeUndefined();
    const handle = toast.success("Saved", { duration: 0 });
    expect(typeof handle.update).toBe("function");
    expect(typeof handle.dismiss).toBe("function");
    expect(() => handle.update("Done", { variant: "error" })).not.toThrow();
    expect(() => handle.dismiss()).not.toThrow();
    expect(() => toast.dismissAll()).not.toThrow();
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { AppWorkspaceSidebarSwitcherProps } from "./SidebarSwitcher";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-sidebar-switcher-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: AppWorkspace } = await import("./AppWorkspace");
const { APP_WORKSPACE_SWITCHER_SEARCH_FROM } = await import("./SidebarSwitcher");
const { LocaleProvider } = await import("../intl/locale");

const current = { id: "work", label: "Work", href: "#work" };
const head = { currentId: current.id, label: current.label, icon: "ti-notebook", switchLabel: "Switch notebook" };
const options = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ ...current, id: `book-${index}`, label: `Book ${index}` }));
const render = (props: Partial<AppWorkspaceSidebarSwitcherProps> = {}, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(AppWorkspace.SidebarSwitcher, { ...head, options: [current], ...props });
      },
    }),
  );

describe("AppWorkspace.SidebarSwitcher", () => {
  test("one container is a link marked current with a visible check and no search", () => {
    const html = render();
    expect(html).toMatch(/<a [^>]*href="#work"[^>]*aria-current="true"/);
    expect(html).toContain('class="ti ti-check k2b-dropdown__check" aria-hidden="true"');
    expect(html).not.toContain('type="search"');
    expect(html).toContain('class="ti ti-notebook"');
    expect(html).toContain("k2b-sidebar-switcher__chevron");
  });

  test("search begins at eight containers", () => {
    expect(APP_WORKSPACE_SWITCHER_SEARCH_FROM).toBe(8);
    expect(render({ options: options(APP_WORKSPACE_SWITCHER_SEARCH_FROM) })).toContain('type="search"');
    expect(render({ options: options(APP_WORKSPACE_SWITCHER_SEARCH_FROM - 1) })).not.toContain('type="search"');
  });

  test("the full title remains available for long names", () => {
    const label = "A notebook with a very long name that does not fit in the sidebar column";
    expect(render({ label })).toContain(`title="${label}"`);
    expect(render({ label })).toContain(`aria-label="${label}"`);
  });

  test("actions contain only the supplied links and buttons", () => {
    const html = render({ actions: [{ id: "all", label: "All notebooks", icon: "ti-list", href: "/notebooks" }] });
    expect(html).toContain('class="k2b-sidebar-switcher__actions"');
    expect(html).toContain('href="/notebooks"');
    expect(html).toContain("All notebooks");
    expect(html).not.toContain("New ");
    for (const actions of [undefined, []]) expect(render({ actions })).not.toContain("k2b-sidebar-switcher__actions");
    const disabled = render({
      actions: [
        { id: "new", label: "New notebook", icon: "ti-plus", action: () => {}, disabled: true },
        { id: "all", label: "All notebooks", icon: "ti-list", href: "/notebooks", disabled: true },
      ],
    });
    expect(disabled.match(/aria-disabled="true"/g)).toHaveLength(2);
    expect(disabled).toMatch(/<button[^>]*disabled/);
    expect(disabled).not.toContain('href="/notebooks"');
  });

  test("undefined options show a loading status; errors offer retry", () => {
    expect(render({ options: undefined })).toMatch(/role="status"[\s\S]*Loading\.\.\./);
    const html = render({ options: undefined, error: "Could not load notebooks", onLoad: () => {} });
    expect(html).toContain("Could not load notebooks");
    expect(html).toMatch(/<button[^>]*data-switcher-row[^>]*>Retry<\/button>/);
    expect(html).not.toContain("Loading...");
  });

  test("the optional description is visible and joins the screen reader purpose", () => {
    const html = render({ description: "team@example.com" });
    expect(html).toContain("data-description");
    expect(html).toContain("<small>team@example.com</small>");
    expect(html).toMatch(/class="k2b-sr-only">team@example.com, Switch notebook<\/span>/);
    expect(render()).not.toContain("data-description");
  });

  test("the trigger names and controls its dialog and purpose text", () => {
    const html = render();
    const panelId = html.match(/aria-controls="([^"]+)"/)?.[1];
    expect(panelId).toBeDefined();
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(`aria-describedby="${panelId}-purpose"`);
    expect(html).toContain(`id="${panelId}-purpose" class="k2b-sr-only">Switch notebook`);
    expect(html).toContain(`id="${panelId}" popover="auto" tabindex="-1" role="dialog" aria-label="Switch notebook"`);
  });

  test("the locale provider supplies search, loading, empty and retry messages", () => {
    expect(render({ options: options(8) })).toContain('placeholder="Search..."');
    expect(render({ options: options(8) }, "de")).toContain('placeholder="Suchen..."');
    expect(render({ options: undefined }, "de")).toContain("Wird geladen...");
    expect(render({ options: [] }, "de")).toMatch(/role="status">Keine Ergebnisse/);
    expect(render({ options: undefined, error: "Fehler" }, "de")).toContain("Erneut versuchen");
  });
});

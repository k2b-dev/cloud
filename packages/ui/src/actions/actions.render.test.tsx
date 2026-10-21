import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import type { DropdownItem as PublicDropdownItem } from "../index";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-actions-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const {
  AppWorkspace,
  PageTrailProvider,
  Button,
  ButtonLink,
  ContextMenu,
  CopyButton,
  Disclosure,
  Dropdown,
  dropdownPosition,
  FilterChip,
  FilterToggle,
  IconButton,
  IconButtonLink,
  LocaleProvider,
  RemoveButton,
  SegmentedControl,
  SplitButton,
  SpotlightButton,
  Tabs,
  ViewTabs,
  Toolbar,
} = await import("../index");
const { copyText } = await import("./CopyButton");
const { viewTabsLayout } = await import("./ViewTabs");
const actionsCss = await Bun.file(resolve(import.meta.dir, "../styles/index.css")).text();
const dropdownSource = await Bun.file(resolve(import.meta.dir, "Dropdown.tsx")).text();

/** Body of the first CSS rule declared with exactly `selector`. */
const rule = (selector: string): string => {
  const index = actionsCss.indexOf(`${selector} {`);
  expect(index, selector).toBeGreaterThan(-1);
  return actionsCss.slice(index, actionsCss.indexOf("}", index));
};

describe("@k2b/ui complete action migrations", () => {
  test("renders accessible tabs, disclosures, and toolbars", () => {
    const tabs = renderToString(() =>
      createComponent(Tabs, {
        ariaLabel: "Project view",
        value: "overview",
        onValueChange: () => {},
        options: [
          { value: "overview", label: "Overview", icon: "ti ti-home", panel: "Overview panel" },
          { value: "activity", label: "Activity", disabled: true, panel: "Activity panel" },
        ],
      }),
    );
    const disclosure = renderToString(() => createComponent(Disclosure, { summary: "Advanced", defaultValue: true, children: "Details" }));
    const toolbar = renderToString(() =>
      createComponent(Toolbar, {
        label: "Document actions",
        wrap: true,
        get children() {
          return [
            createComponent(Toolbar.Group, {
              label: "Edit",
              get children() {
                return createComponent(Button, { children: "Edit" });
              },
            }),
            createComponent(Toolbar.Separator, {}),
            createComponent(Toolbar.Spacer, {}),
          ];
        },
      }),
    );
    const verticalToolbar = renderToString(() =>
      createComponent(Toolbar, {
        label: "Block actions",
        orientation: "vertical",
        get children() {
          return createComponent(Toolbar.Separator, {});
        },
      }),
    );

    expect(tabs).toContain('role="tablist"');
    expect(tabs).toContain('aria-selected="true"');
    expect(tabs).toContain('role="tabpanel"');
    expect(disclosure).toContain("<details");
    expect(disclosure).toContain("open");
    expect(disclosure).toContain('data-surface="paper"');
    const plain = renderToString(() => createComponent(Disclosure, { summary: "Details", surface: "plain", children: "Content" }));
    expect(plain).toContain('data-surface="plain"');
    expect(rule('.k2b-ui .k2b-disclosure[data-surface="plain"]')).toContain("background: transparent");
    expect(rule('.k2b-ui .k2b-disclosure:not([open]):not([data-disabled="true"]) > summary:hover')).toContain("var(--k2b-hover)");
    expect(rule(".k2b-ui .k2b-disclosure[open]")).toContain("color-mix");
    expect(rule('.k2b-ui .k2b-disclosure[open]:not([data-disabled="true"]):has(> summary:hover)')).toContain("var(--k2b-hover)");
    expect(toolbar).not.toContain("tabindex=");
    expect(verticalToolbar).not.toContain("tabindex=");
    expect(toolbar).toContain('role="toolbar"');
    expect(toolbar).toContain('aria-label="Document actions"');
    expect(toolbar).toContain('role="separator"');
    expect(toolbar).toContain('role="separator" aria-orientation="vertical" data-orientation="vertical"');
    expect(verticalToolbar).toContain('role="separator" aria-orientation="horizontal" data-orientation="horizontal"');
    expect(rule(".k2b-ui .k2b-disclosure")).toContain("width: 100%");
    expect(rule(".k2b-ui .k2b-disclosure")).toContain("align-self: stretch");
    expect(rule(".k2b-ui .k2b-disclosure > summary")).toContain("user-select: none");
    expect(actionsCss).not.toContain(".k2b-disclosure > summary:hover { background:");
    expect(rule('.k2b-ui .k2b-disclosure:not([data-disabled="true"]) > summary:hover .k2b-disclosure__chevron')).toContain(
      "var(--k2b-action)",
    );
  });

  test("keeps the first enabled tab in the tab order when the controlled value is unavailable", () => {
    const unavailable = renderToString(() =>
      createComponent(Tabs, {
        ariaLabel: "Project view",
        value: "missing",
        onValueChange: () => {},
        options: [
          { value: "disabled", label: "Disabled", disabled: true },
          { value: "overview", label: "Overview" },
          { value: "activity", label: "Activity" },
        ],
      }),
    );
    const disabled = renderToString(() =>
      createComponent(Tabs, {
        ariaLabel: "Project view",
        value: "disabled",
        onValueChange: () => {},
        options: [
          { value: "disabled", label: "Disabled", disabled: true },
          { value: "overview", label: "Overview" },
        ],
      }),
    );

    expect(unavailable.match(/tabindex="0"/g)).toHaveLength(1);
    expect(unavailable).toMatch(/tabindex="0"[^>]*><span>Overview<\/span>/);
    expect(disabled.match(/tabindex="0"/g)).toHaveLength(1);
    expect(disabled).toMatch(/tabindex="0"[^>]*><span>Overview<\/span>/);
  });

  test("renders compositional tab items with their colocated panel", () => {
    const tabs = renderToString(() =>
      createComponent(Tabs, {
        ariaLabel: "Project sections",
        value: "overview",
        onValueChange: () => {},
        get children() {
          return [
            createComponent(Tabs.Item, { value: "overview", label: "Overview", children: "Summary" }),
            createComponent(Tabs.Item, { value: "activity", label: "Activity", children: "Changes" }),
          ];
        },
      }),
    );

    expect(tabs).toContain('role="tablist"');
    expect(tabs).toContain('aria-selected="true"');
    expect(tabs).toContain('role="tabpanel"');
    expect(tabs).toContain("Summary");
    expect(tabs).not.toContain("Changes");
  });

  test("renders compact subtle actions through the shared button contract", () => {
    const button = renderToString(() => createComponent(Button, { size: "xs", variant: "subtle", children: "Status" }));

    expect(button).toContain('data-size="xs"');
    expect(button).toContain('data-variant="subtle"');
    expect(button).toContain('type="button"');
    expect(rule('.k2b-ui .k2b-button[data-size="xs"]')).toContain("min-height: 1.5rem");
    expect(rule('.k2b-ui .k2b-button[data-variant="subtle"]')).toContain("background: var(--k2b-field-surface, var(--k2b-surface-muted))");
    const warningRule = rule('.k2b-ui .k2b-button[data-variant="warning"]');
    expect(warningRule).toContain("color: #422006");
    expect(warningRule).toContain("background: var(--k2b-warning-500)");
    expect(rule('.k2b-ui .k2b-button[data-variant="danger"]:not(:disabled, [aria-disabled="true"]):hover')).toContain(
      "background: color-mix(in srgb, var(--k2b-danger-600) 86%, #000000)",
    );
    expect(rule('.k2b-ui .k2b-button[data-variant="success"]:not(:disabled, [aria-disabled="true"]):hover')).toContain(
      "background: color-mix(in srgb, var(--k2b-success-600) 86%, #000000)",
    );
    const aiRule = rule('.k2b-ui .k2b-button[data-variant="ai"]');
    expect(aiRule).toContain("color: var(--k2b-ai-on-solid)");
    expect(aiRule).toContain("background: var(--k2b-ai-solid)");
  });

  test("aligns input actions with adjacent field controls", () => {
    const button = renderToString(() =>
      createComponent(IconButton, {
        label: "Add filter",
        variant: "input",
        children: "+",
      }),
    );

    expect(button).toContain('data-variant="input"');
    const inputRule = rule('.k2b-ui .k2b-button[data-variant="input"]');
    expect(inputRule).toContain("min-height: 2.25rem");
    expect(inputRule).toContain("background: var(--k2b-field-surface, var(--k2b-surface-muted))");
    expect(rule('.k2b-ui .k2b-icon-button[data-variant="input"]')).toContain("width: 2.25rem");
  });

  test("supports explicit wrapping across buttons, links, and split button modes", () => {
    const normal = renderToString(() => createComponent(Button, { children: "New client" }));
    expect(normal).not.toContain("data-wrap");
    const wrapped = [
      renderToString(() =>
        createComponent(Button, { wrap: true, loading: true, loadingLabel: "Creating a new client", children: "New client" }),
      ),
      renderToString(() => createComponent(ButtonLink, { wrap: true, href: "/clients", children: "Open all clients" })),
      renderToString(() =>
        createComponent(ButtonLink, {
          wrap: true,
          href: "/clients",
          navigation: "enhanced",
          onNavigate: () => {},
          children: "Open all clients",
        }),
      ),
      ...[undefined, [{ label: "Create client", action: () => {} }]].map((primaryItems) =>
        renderToString(() =>
          createComponent(SplitButton, { wrap: true, children: "Create a new client", menuLabel: "More actions", items: [], primaryItems }),
        ),
      ),
    ];
    for (const html of wrapped) {
      expect(html).toContain('data-wrap="true"');
      expect(html).not.toMatch(/\s+wrap=/);
    }
    expect(wrapped[0]).toContain("Creating a new client");
  });

  test("start-aligns row content across buttons and links with a filling label", () => {
    expect(renderToString(() => createComponent(Button, { children: "Save" }))).not.toContain("data-align");
    expect(renderToString(() => createComponent(Button, { align: "center", children: "Save" }))).not.toContain("data-align");
    const rows = [
      renderToString(() => createComponent(Button, { align: "start", children: "Maria Kolb" })),
      renderToString(() => createComponent(ButtonLink, { align: "start", href: "/users/1", children: "Maria Kolb" })),
      renderToString(() =>
        createComponent(ButtonLink, {
          align: "start",
          href: "/users/1",
          navigation: "enhanced",
          onNavigate: () => {},
          children: "Maria Kolb",
        }),
      ),
    ];
    for (const html of rows) {
      expect(html).toContain('data-align="start"');
      expect(html).not.toMatch(/\salign=/);
    }

    const button = rule('.k2b-ui .k2b-button[data-align="start"]');
    expect(button).toContain("justify-content: flex-start");
    expect(button).toContain("text-align: start");
    const label = rule('.k2b-ui .k2b-button[data-align="start"] > .k2b-button__label');
    expect(label).toContain("flex: 1 1 auto");
    expect(label).toContain("min-width: 0");
    expect(label).toContain("justify-content: flex-start");
  });

  test("renders surface-free text actions through the shared button contract", () => {
    const button = renderToString(() => createComponent(Button, { size: "xs", variant: "text", children: "More" }));
    const link = renderToString(() => createComponent(ButtonLink, { href: "/more", size: "sm", variant: "text", children: "More" }));

    expect(button).toContain('data-size="xs"');
    expect(button).toContain('data-variant="text"');
    expect(link).toContain('data-size="sm" data-variant="text"');
    const textRule = rule('.k2b-ui .k2b-button[data-variant="text"]');
    expect(textRule).toContain("padding-inline: 0");
    expect(textRule).toContain("border-inline-width: 0");
    expect(textRule).toContain("background: transparent");
    const hoverRule = rule('.k2b-ui .k2b-button[data-variant="text"]:not(:disabled, [aria-disabled="true"]):hover');
    expect(hoverRule).toContain("color: var(--k2b-text)");
    expect(hoverRule).toContain("background: transparent");
  });

  test("renders a split button as separate primary and menu actions", () => {
    const explicit = renderToString(() =>
      createComponent(SplitButton, {
        items: [{ label: "Save as draft", action: () => {} }],
        menuLabel: "More send options",
        size: "sm",
        variant: "secondary",
        children: "Send",
      }),
    );
    const implicit = renderToString(() =>
      createComponent(SplitButton, {
        items: [{ label: "Save as draft", action: () => {} }],
        menuLabel: "More send options",
        children: "Send",
      }),
    );

    expect(explicit.match(/<button/g)).toHaveLength(3);
    expect(explicit).toContain("k2b-split-button__primary");
    expect(explicit).toContain("k2b-split-button__menu-trigger");
    expect(explicit).toContain('aria-label="More send options"');
    expect(explicit).toContain('aria-haspopup="menu"');
    expect(explicit).toContain('data-size="sm"');
    expect(explicit.match(/data-variant="secondary"/g)).toHaveLength(2);
    expect(implicit.match(/data-variant="primary"/g)).toHaveLength(2);
    expect(explicit).toContain("Save as draft");
    expect(rule(".k2b-ui .k2b-dropdown.k2b-split-button")).toContain("gap: 0");
  });

  test("renders separate file selection and file action menus", () => {
    const html = renderToString(() =>
      createComponent(SplitButton, {
        primaryItems: [{ label: "other.ts", action: () => {} }],
        primaryMenuLabel: "Choose file",
        items: [{ label: "Rename file", action: () => {} }],
        menuLabel: "File actions",
        menuIcon: "...",
        children: "main.ts",
      }),
    );
    expect(html).toContain('aria-label="Choose file"');
    expect(html).toContain('aria-label="File actions"');
    expect(html.match(/aria-haspopup="menu"/g)).toHaveLength(2);
    expect(html).toContain("other.ts");
    expect(html).toContain("Rename file");
  });

  test("disables both split button actions while loading", () => {
    const html = renderToString(() =>
      createComponent(SplitButton, {
        items: [{ label: "Save as draft", action: () => {} }],
        loading: true,
        loadingLabel: "Sending",
        menuLabel: "More send options",
        children: "Send",
      }),
    );

    expect(html).toContain("Sending");
    expect(html.match(/ disabled/g)).toHaveLength(2);
    expect(html).toContain('aria-busy="true"');
  });

  test("renders navigational actions as styled links", () => {
    const html = renderToString(() =>
      createComponent(ButtonLink, { href: "/items", size: "sm", variant: "secondary", children: "Open items" }),
    );

    expect(html).toContain("<a ");
    expect(html).toContain('href="/items"');
    expect(html).toContain('class="k2b-button');
    expect(html).toContain('data-size="sm" data-variant="secondary"');
    expect(html).toContain('<span class="k2b-button__label">Open items</span>');
    expect(html).not.toContain("<button");
    expect(rule(".k2b-ui .k2b-button")).toContain("text-decoration: none");
  });

  test("keeps enhanced navigation opt-in and out of server HTML", () => {
    const html = renderToString(() =>
      createComponent(ButtonLink, {
        href: "/items",
        navigation: "enhanced",
        scroll: "preserve",
        children: "Open items",
      }),
    );

    expect(html).toContain("<a ");
    expect(html).toContain('href="/items"');
    expect(html).toContain('class="k2b-button');
    expect(html).not.toContain("navigation=");
    expect(html).not.toContain("scroll=");
  });

  test("renders icon-only navigational actions through the public link contract", () => {
    const html = renderToString(() =>
      createComponent(IconButtonLink, {
        href: "/items",
        label: "Back to items",
        children: "Back",
      }),
    );

    expect(html).toContain("<a ");
    expect(html).toContain('href="/items"');
    expect(html).toContain("k2b-icon-button");
    expect(html).toContain('data-variant="ghost"');
    expect(html).toContain('aria-label="Back to items"');
    expect(html).toContain('title="Back to items"');
    expect(html).not.toContain("<button");
  });

  test("renders an explicit SSR trigger with declarative sections, links, and actions", () => {
    const elements: PublicDropdownItem[] = [
      { label: "Rename", icon: "ti ti-pencil", action: () => {} },
      {
        sectionLabel: "Links",
        items: [{ label: "Documentation", href: "/docs" }],
      },
    ];
    const html = renderToString(() =>
      createComponent(Dropdown.Root, {
        items: elements,
        get children() {
          return createComponent(Dropdown.Trigger, { label: "Project actions", children: "Open" });
        },
      }),
    );

    expect(html).toContain('popover="auto"');
    expect(html).toContain('role="menu"');
    expect(html).toContain("Project actions");
    expect(html).toContain("Links");
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Links"');
    expect(html).toContain('href="/docs"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="k2b-dropdown-');
  });

  test("keeps icon-only dropdown triggers quiet unless a variant is explicit", () => {
    const iconOnly = renderToString(() =>
      createComponent(Dropdown.Root, {
        items: [{ label: "Rename", action: () => {} }],
        get children() {
          return createComponent(Dropdown.Trigger, { iconOnly: true, label: "Project actions", children: "A" });
        },
      }),
    );
    const labelled = renderToString(() =>
      createComponent(Dropdown.Root, {
        items: [{ label: "Rename", action: () => {} }],
        get children() {
          return createComponent(Dropdown.Trigger, { children: "Actions" });
        },
      }),
    );
    const explicit = renderToString(() =>
      createComponent(Dropdown.Root, {
        items: [{ label: "Create", action: () => {} }],
        get children() {
          return createComponent(Dropdown.Trigger, {
            iconOnly: true,
            label: "Create",
            variant: "primary",
            children: "+",
          });
        },
      }),
    );

    expect(iconOnly).toContain("k2b-icon-button");
    expect(iconOnly).toContain('data-variant="ghost"');
    expect(labelled).toContain('data-variant="primary"');
    expect(explicit).toContain('data-variant="primary"');
  });

  test("dropdown links keep quiet trailing counts separate from their labels", () => {
    const html = renderToString(() =>
      createComponent(Dropdown.Root, {
        items: [{ href: "?view=archive", label: "Archive", trailing: "7" }],
        get children() {
          return createComponent(Dropdown.Trigger, { label: "More views", children: "More" });
        },
      }),
    );
    expect(html).toContain('href="?view=archive"');
    expect(html).toMatch(/class="k2b-dropdown__copy"><span>Archive<\/span>.*?<\/span>7/s);
  });

  test("clamps every dropdown position to the viewport", () => {
    const trigger = { left: 290, right: 310, top: 180, bottom: 200 } as DOMRect;
    const bottom = dropdownPosition(trigger, { width: 120, height: 80 }, "bottom-right", { width: 320, height: 240 });
    const top = dropdownPosition(trigger, { width: 120, height: 80 }, "top-left", { width: 320, height: 240 });

    expect(bottom).toEqual({ left: 192, top: 152 });
    expect(top).toEqual({ left: 190, top: 96 });
  });

  test("renders section-aware filter state and reset action", () => {
    const html = renderToString(() =>
      createComponent(FilterChip, {
        label: "State",
        icon: "ti ti-filter",
        value: ["open", "urgent"],
        onValueChange: () => {},
        defaultValue: ["open"],
        options: [
          {
            label: "State",
            options: [
              { value: "open", label: "Open" },
              { value: "closed", label: "Closed" },
            ],
          },
          {
            label: "Flags",
            multiple: true,
            options: [{ value: "urgent", label: "Urgent", color: "#ef4444" }],
          },
        ],
      }),
    );

    expect(html).toContain('data-active="true"');
    expect(html).toContain('role="menuitemradio"');
    expect(html).toContain('role="menuitemcheckbox"');
    expect(html).toContain('aria-checked="true"');
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain('aria-label="Filter actions"');
    expect(html).toContain("Reset");
    // The menu sizes to its longest option with the former 13rem as its floor.
    expect(html).toContain("k2b-filter-chip__menu");
    expect(html).not.toContain("--k2b-dropdown-width");
    expect(rule(".k2b-ui .k2b-dropdown__menu.k2b-filter-chip__menu")).toContain("min-width: min(13rem, 100vw - 2rem)");
  });

  test("renders a row section as one segmented row of radio choices", () => {
    const html = renderToString(() =>
      createComponent(FilterChip, {
        label: "View",
        icon: "ti ti-filter",
        value: ["sort:asc"],
        defaultValue: ["sort:asc"],
        onValueChange: () => {},
        options: [
          {
            label: "Sort",
            layout: "row",
            options: [
              { value: "sort:asc", label: "Ascending", icon: "ti ti-arrow-up" },
              { value: "sort:desc", label: "Descending", icon: "ti ti-arrow-down" },
            ],
          },
        ],
      }),
    );

    expect(html).toMatch(
      /role="group" aria-label="Sort"><div class="k2b-dropdown__label">Sort<\/div>(?:<!--[^>]*-->)*<div class="k2b-dropdown__row">/,
    );
    expect(html.match(/<div class="k2b-dropdown__row">(.*?)<\/div><\/div>/s)?.[1]?.match(/role="menuitemradio"/g)).toHaveLength(2);
    expect(rule(".k2b-ui .k2b-dropdown__row")).toContain("background: var(--k2b-field-surface, var(--k2b-surface-muted))");
    expect(rule(".k2b-ui .k2b-dropdown__row > .k2b-dropdown__item > i")).toContain("display: none");
    expect(rule('.k2b-ui .k2b-dropdown__row > .k2b-dropdown__item[data-selected="true"]')).toContain("background: var(--k2b-surface)");

    // A row of choices is no set of actions: without a label its group stays unnamed instead of "Actions".
    const unlabeled = renderToString(() =>
      createComponent(FilterChip, {
        label: "View",
        icon: "ti ti-filter",
        value: ["sort:asc"],
        defaultValue: ["sort:asc"],
        onValueChange: () => {},
        options: [{ layout: "row", options: [{ value: "sort:asc", label: "Ascending" }] }],
      }),
    );
    expect(unlabeled).toMatch(/role="group"(?:(?!aria-label)[^>])*>(?:<!--[^>]*-->)*<div class="k2b-dropdown__row">/);
    expect(unlabeled).not.toContain('aria-label="Actions"');
  });

  test("treats an empty filter default as clear mode and keeps the selected count", () => {
    const html = renderToString(() =>
      createComponent(FilterChip, {
        label: "State",
        icon: "ti ti-filter",
        value: ["open"],
        onValueChange: () => {},
        defaultValue: [],
        options: [{ options: [{ value: "open", label: "Open" }] }],
      }),
    );

    expect(html).toContain("State (1)");
    expect(html).toContain("Clear");
    expect(html).not.toContain("Reset");
  });

  test("sizes menus to their entries and applies an explicit width as a real CSS length", () => {
    const sized = renderToString(() =>
      createComponent(Dropdown.Root, {
        width: "10rem",
        items: [{ label: "Rename", action: () => {} }],
        get children() {
          return createComponent(Dropdown.Trigger, { children: "Open" });
        },
      }),
    );
    const unsized = renderToString(() =>
      createComponent(Dropdown.Root, {
        items: [{ label: "Rename", action: () => {} }],
        get children() {
          return createComponent(Dropdown.Trigger, { children: "Open" });
        },
      }),
    );

    // The package ships no utility classes, so a class-name passthrough would be
    // dead API for every standalone consumer.
    expect(sized).toContain("--k2b-dropdown-width:10rem");
    expect(sized).toContain('data-width="fixed"');
    expect(sized).not.toContain('class="k2b-dropdown__menu 10rem');
    expect(unsized).not.toContain("--k2b-dropdown-width");
    expect(unsized).not.toContain("data-width");
    // Without a width the menu grows with its longest entry from the compact
    // default up to the viewport.
    const menu = rule(".k2b-ui .k2b-dropdown__menu");
    expect(menu).toContain("width: max-content");
    expect(menu).toContain("min-width: min(12rem, 100vw - 2rem)");
    expect(menu).toContain("max-width: calc(100vw - 2rem)");
    // An explicit width is exact: nothing may clamp a narrower request.
    const fixed = rule('.k2b-ui .k2b-dropdown__menu[data-width="fixed"]');
    expect(fixed).toContain("width: var(--k2b-dropdown-width)");
    expect(fixed).toContain("min-width: 0");
    // Entries wrap instead of truncating.
    const copy = rule(".k2b-ui .k2b-dropdown__copy > span,\n.k2b-ui .k2b-dropdown__copy > small");
    expect(copy).toContain("overflow-wrap: anywhere");
    expect(copy).not.toContain("ellipsis");
    expect(menu).toContain("display: none");
    expect(menu).toContain("flex-direction: column");
    expect(menu).toContain("transition: none");
    expect(rule(".k2b-ui .k2b-dropdown__menu:popover-open")).toContain("display: flex");
  });

  test("keeps viewport listeners scoped to an open dropdown", () => {
    expect(dropdownSource).toContain("const attachViewportListeners");
    expect(dropdownSource).toContain("const detachViewportListeners");
    expect(dropdownSource).not.toMatch(/onMount\(\(\) => \{[\s\S]*?window\.addEventListener\("scroll", reposition, true\)/);
  });

  test("keeps unlabelled filter sections flat so only the reset action is separated", () => {
    const html = renderToString(() =>
      createComponent(FilterChip, {
        label: "State",
        icon: "ti ti-filter",
        value: ["open"],
        onValueChange: () => {},
        options: [
          {
            options: [
              { value: "open", label: "Open" },
              { value: "closed", label: "Closed" },
            ],
          },
        ],
      }),
    );

    // Cloud spreads unlabelled option groups as flat items; only the trailing
    // clear/reset group is wrapped in a spaced section.
    expect(html.match(/k2b-dropdown__section/g)?.length).toBe(1);
    expect(html).toContain('data-divided="true"');
    expect(html).toContain("Clear");
  });

  test("renders accessor-based segmented controls without dividers", () => {
    const html = renderToString(() =>
      createComponent(SegmentedControl, {
        ariaLabel: "Layout",
        value: () => "list",
        onValueChange: () => {},
        options: [
          { value: "table", label: "Table", icon: "ti ti-table" },
          { value: "cards", label: "Cards", disabled: true },
          { value: "list", label: "List" },
        ],
      }),
    );

    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Layout"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("ti ti-table");
    expect(html).toContain("disabled");
    expect(html).not.toContain("data-divider");
    // Layout belongs to the stylesheet, without inline geometry.
    expect(html).not.toContain("style=");
  });

  test("keeps CopyButton neutral and propagates clipboard failures after reporting them", async () => {
    const html = renderToString(() => createComponent(CopyButton, { text: "value", label: "Copy value" }));
    const failure = new Error("clipboard unavailable");
    let reported: unknown;

    expect(html).toContain('data-variant="ghost"');
    expect(html).toContain("Copy value");
    expect(html).not.toContain('data-variant="primary"');

    await expect(
      copyText(
        "value",
        (error) => {
          reported = error;
        },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(reported).toBe(failure);
  });

  test("CopyButton composes a consumer class onto its styled base", () => {
    // Cloud replaced the base class outright (`props.class ?? "btn-simple …"`),
    // which was safe there because the base was a swappable Tailwind utility
    // set. The package emits no utilities, so `k2b-button` is the *only* source
    // of layout, size and variant styling — dropping it leaves a bare native
    // button that still advertises `data-size`/`data-variant`.
    const styled = renderToString(() => createComponent(CopyButton, { text: "value", label: "Copy value", class: "my-toolbar-button" }));

    expect(styled).toContain("k2b-button");
    expect(styled).toContain("k2b-copy-button");
    expect(styled).toContain("my-toolbar-button");

    // Same composition shape as Button/IconButton, base first.
    const plain = renderToString(() => createComponent(CopyButton, { text: "value", label: "Copy value" }));
    expect(plain).toMatch(/class="k2b-button k2b-copy-button\s*"/);
  });

  test("CopyButton renders icon-only when no label is given and honours iconOnly", () => {
    // `iconOnly` defaults to "no label was supplied", matching Cloud, and an
    // icon-only trigger has to carry the accessible name on the button itself.
    const implicit = renderToString(() => createComponent(CopyButton, { text: "value" }));
    expect(implicit).toContain('aria-label="Copy"');
    expect(implicit).toContain("k2b-sr-only");
    expect(implicit).toContain("ti ti-copy");

    // A label alone switches to the labelled form: visible text, no aria-label.
    const labelled = renderToString(() => createComponent(CopyButton, { text: "value", label: "Copy value" }));
    expect(labelled).not.toContain("aria-label=");
    expect(labelled).toContain("Copy value");

    // …unless the caller forces icon-only, which keeps the label as the name.
    const forced = renderToString(() => createComponent(CopyButton, { text: "value", label: "Copy value", iconOnly: true }));
    expect(forced).toContain('aria-label="Copy value"');
    expect(forced).not.toContain("<span>Copy value</span>");
  });

  test("CopyButton reflects loading and disabled state on the button element", () => {
    const loading = renderToString(() =>
      createComponent(CopyButton, { text: "value", label: "Copy value", loading: true, loadingLabel: "Copying…" }),
    );

    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("disabled");
    expect(loading).toContain("ti ti-loader-2");
    expect(loading).toContain("Copying…");

    const disabled = renderToString(() => createComponent(CopyButton, { text: "value", label: "Copy value", disabled: true }));
    expect(disabled).toContain("disabled");
    expect(disabled).not.toContain('aria-busy="true"');
  });

  test("CopyButton accepts `value` as an alias for `text` and never leaks it as an attribute", () => {
    // Both halves of the CopyValue union have to reach the clipboard, and
    // neither may survive into the DOM as a `<button value=…>` attribute.
    const byValue = renderToString(() => createComponent(CopyButton, { value: "secret", label: "Copy" }));

    expect(byValue).not.toContain('value="secret"');
    expect(byValue).not.toContain("text=");
    expect(byValue).toContain('type="button"');
  });

  test("renders copy, remove, context, and every spotlight trigger contract", () => {
    const copy = renderToString(() => createComponent(CopyButton, { text: "value" }));
    const remove = renderToString(() => createComponent(RemoveButton, { ariaLabel: "Remove member", loading: true }));
    const context = renderToString(() =>
      createComponent(ContextMenu, {
        items: [{ label: "Remove", variant: "danger", action: () => {} }],
        children: "Target",
      }),
    );
    const spotlight = renderToString(() =>
      createComponent(SpotlightButton, {
        variant: "sidebar",
        shortcutLabel: "Ctrl K",
        onClick: () => {},
      }),
    );

    expect(copy).toContain('aria-label="Copy"');
    expect(copy).toContain('role="tooltip"');
    expect(remove).toContain('aria-label="Remove member"');
    expect(remove).toContain('aria-busy="true"');
    expect(context).toContain('role="group"');
    expect(context).toContain('aria-haspopup="menu"');
    expect(context).toContain('aria-expanded="false"');
    expect(context).toContain("Target");
    expect(spotlight).toContain('data-variant="sidebar"');
    expect(spotlight).toContain("Ctrl K");
  });

  test("requires an explicit accessible label for the remove button", () => {
    const remove = renderToString(() => createComponent(RemoveButton, { ariaLabel: "Remove attachment" }));

    expect(remove).toContain('aria-label="Remove attachment"');
  });

  test("keeps an icon button quiet by default, like Cloud's icon-btn utility", () => {
    const implicit = renderToString(() => createComponent(IconButton, { label: "Settings", children: "S" }));
    const explicit = renderToString(() => createComponent(IconButton, { label: "Save", variant: "primary", children: "S" }));

    expect(implicit).toContain('data-variant="ghost"');
    expect(implicit).toContain('aria-label="Settings"');
    expect(implicit).toContain('title="Settings"');
    expect(explicit).toContain('data-variant="primary"');
  });

  test("server-renders an icon-only control's label as its tooltip and native fallback title", () => {
    const button = renderToString(() => createComponent(IconButton, { label: "Zoom in", children: "+" }));
    const link = renderToString(() => createComponent(IconButtonLink, { href: "/items", label: "Back to items", children: "Back" }));
    const quiet = renderToString(() => createComponent(IconButton, { label: "Close", tooltip: false, children: "x" }));

    expect(button).toMatch(/<span[^>]*role="tooltip"[^>]*>Zoom in<\/span>/);
    expect(link).toMatch(/<span[^>]*role="tooltip"[^>]*>Back to items<\/span>/);
    expect(quiet).not.toContain('role="tooltip"');
    expect(quiet).not.toContain("title=");
  });

  test("keeps icon-button loading labels accessible without overflowing the square control", () => {
    const html = renderToString(() =>
      createComponent(IconButton, {
        label: "Save",
        loading: true,
        loadingLabel: "Saving",
        children: "save icon",
      }),
    );

    expect(html).toContain('aria-label="Saving"');
    expect(html).toContain("ti-loader-2");
    expect(html).not.toContain(">Saving<");
    // The icon keeps its place under the spinner, invisibly.
    expect(html).toContain("k2b-button__busy");
    expect(html).toContain("save icon");
  });

  test("keeps a busy button's content in place and names it by its loading label", () => {
    const idle = renderToString(() => createComponent(Button, { loadingLabel: "Saving", children: "Save" }));
    expect(idle).not.toContain("aria-busy");
    expect(idle).not.toContain("aria-label");
    expect(idle).not.toContain("k2b-button__busy");
    expect(idle).not.toContain("Saving");

    const busy = renderToString(() => createComponent(Button, { loading: true, loadingLabel: "Saving", children: "Save" }));
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toContain('aria-label="Saving"');
    expect(busy).toContain("disabled");
    expect(busy).toMatch(/<span class="k2b-button__label">Save<\/span>/);
    expect(busy).toMatch(/<span class="k2b-button__busy" aria-hidden="true"><i class="ti ti-loader-2 k2b-spin"><\/i><\/span>/);

    // Without a loading label the idle label stays the accessible name.
    const unnamed = renderToString(() => createComponent(Button, { loading: true, children: "Save" }));
    expect(unnamed).not.toContain("aria-label");
    expect(unnamed).toMatch(/<span class="k2b-button__label">Save<\/span>/);

    // A loading label also replaces a name the caller gave the button, and
    // the caller's name comes back once the button is idle again.
    const named = (loading: boolean) =>
      renderToString(() =>
        createComponent(Button, {
          loading,
          loadingLabel: "Creating the book",
          "aria-label": "Create a contact book",
          "aria-labelledby": "book-heading",
          children: "New",
        }),
      );
    expect(named(true)).toContain('aria-label="Creating the book"');
    expect(named(true)).not.toContain("aria-labelledby");
    expect(named(false)).toContain('aria-label="Create a contact book"');
    expect(named(false)).toContain('aria-labelledby="book-heading"');

    const css = rule(".k2b-ui .k2b-button__busy");
    expect(css).toContain("position: absolute");
    expect(rule(".k2b-ui .k2b-button:has(> .k2b-button__busy) > .k2b-button__label")).toContain("opacity: 0");
  });

  test("gives every spotlight trigger variant a styled surface", () => {
    for (const variant of ["default", "compact", "chip", "sidebar", "sidebar-mobile", "icon"] as const) {
      const html = renderToString(() => createComponent(SpotlightButton, { variant, onClick: () => {} }));
      expect(html).toContain(`data-variant="${variant}"`);
      expect(actionsCss).toContain(`.k2b-ui .k2b-spotlight-button[data-variant="${variant}"]`);
    }
  });
});

describe("@k2b/ui action geometry parity", () => {
  test("segments keep control-sized, flex-1 geometry", () => {
    const control = rule(".k2b-ui .k2b-segmented-control");
    const option = rule(".k2b-ui .k2b-segmented-control__option");

    expect(control).toContain("w-full");
    expect(control).toContain("items-stretch");
    expect(control).toContain("background: transparent");
    expect(option).toContain("flex-1");
    expect(option).toContain("min-height: 2rem");
    expect(option).toContain("padding: 0.25rem 0.5rem");
    // The soft look keeps the former box: no added weight, no gap between options.
    expect(option).not.toContain("font-weight");
    expect(control).not.toContain("gap");
    expect(actionsCss).toMatch(/\.k2b-segmented-control__option:not\([^)]*\):hover/);
  });

  test("menu items and section spacing follow Cloud's menu-item and menu-section metrics", () => {
    const item = rule(".k2b-ui .k2b-dropdown__item");
    const filterOption = rule(".k2b-ui .k2b-filter-chip__option");
    const section = rule('.k2b-ui .k2b-dropdown__section[data-divided="true"]');

    expect(item).toContain("gap: 0.625rem");
    expect(item).toContain("padding: 0.4375rem 0.75rem");
    expect(item).toContain("font-size: 0.8125rem");
    expect(item).toContain("line-height: 1rem");
    expect(filterOption).toContain("line-height: 1rem");
    // Cloud separates sections with spacing, never a rule line.
    expect(section).not.toContain("border-top");
    expect(section).toContain("margin-top: 0.25rem");
  });

  test("the filter trigger matches the geometry and surface of adjacent fields", () => {
    const chip = rule(".k2b-ui .k2b-filter-chip");
    const iconOnly = rule('.k2b-ui .k2b-filter-chip[data-icon-only="true"]');

    expect(chip).toContain("min-height: 2.25rem");
    expect(chip).toContain("border-radius: var(--k2b-radius-control)");
    expect(chip).not.toContain("999px");
    expect(chip).toContain("border: 0");
    expect(chip).toContain("background: var(--k2b-field-surface, var(--k2b-surface-muted))");
    expect(iconOnly).toContain("width: 2.25rem");
    expect(actionsCss).toContain(".k2b-ui .k2b-filter-chip:hover");
  });

  test("buttons use flat, layout-stable press feedback", () => {
    const button = rule(".k2b-ui .k2b-button");
    const active = rule('.k2b-ui .k2b-button:not(:disabled, [aria-disabled="true"]):active');
    const split = rule(".k2b-ui .k2b-dropdown.k2b-split-button");
    const splitSegmentActive = rule('.k2b-ui .k2b-split-button > .k2b-button:not(:disabled, [aria-disabled="true"]):active');
    const splitPrimaryActive = rule(".k2b-ui .k2b-dropdown.k2b-split-button:has(> .k2b-split-button__primary:not(:disabled):active)");
    const disabled = rule('.k2b-ui .k2b-button:is(:disabled, [aria-disabled="true"])');

    expect(button).toContain("transition:");
    expect(button).toContain("user-select: none");
    expect(button).toContain("font-weight: 600");
    expect(active).toContain("scale: 0.98");
    expect(active).not.toContain("box-shadow");
    expect(split).toContain("transition: scale 100ms ease-out");
    expect(splitSegmentActive).toContain("scale: none");
    expect(splitPrimaryActive).toContain("scale: 0.98");
    expect(actionsCss).not.toContain(".k2b-ui .k2b-dropdown.k2b-split-button:has(> .k2b-button:not(:disabled):active)");
    expect(actionsCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(disabled).toContain("opacity: 0.4");
    // A focusable aria-disabled button looks disabled and gets no hover or press feedback.
    for (const variant of ["", '[data-variant="ghost"]', '[data-variant="secondary"]'])
      expect(actionsCss).toContain(`.k2b-ui .k2b-button${variant}:not(:disabled, [aria-disabled="true"]):hover {`);
    expect(actionsCss).not.toMatch(/\.k2b-button[^{}\n]*:not\(:disabled\):(hover|active)/);
  });
});

test("floating Toolbar renders a space-keeping pending pill with every action and keyboard hint", () => {
  const html = renderToString(() =>
    createComponent(Toolbar, {
      label: "Selection actions",
      variant: "floating",
      orientation: "vertical",
      wrap: true,
      class: "selection-tools",
      get children() {
        return [
          createComponent(Toolbar.Label, { children: "3 selected" }),
          createComponent(Toolbar.Action, { label: "Archive", icon: "ti ti-archive", keys: "e", priority: 1 }),
          createComponent(Toolbar.Action, { label: "Forward", icon: "ti ti-forward", priority: 7, disabled: true }),
          createComponent(Toolbar.Action, { label: "Done", icon: "ti ti-check", keys: "escape" }),
        ];
      },
    }),
  );
  expect(html).toMatch(/<div class="k2b-toolbar-float"><div[^>]*class="k2b-toolbar selection-tools"[^>]*role="toolbar"/);
  expect(html).toContain('data-variant="floating"');
  expect(html).toContain("data-overflow-pending");
  expect(html).toContain('data-orientation="horizontal"');
  expect(html).not.toContain('data-wrap="true"');
  expect(html.match(/<button[^>]*k2b-toolbar__action/g)).toHaveLength(3);
  expect(html).toContain('class="k2b-kbd k2b-kbd-hint k2b-toolbar__hint"');
  expect(html).toContain('aria-label="Archive"');
  expect(html).toContain('title="Archive (E)"');
  expect(html).toContain('aria-keyshortcuts="E"');
  expect(html).toContain('aria-keyshortcuts="Escape"');
  // Only the idle More wrapper is hidden on the server; all actions are present.
  expect(html.match(/data-overflow="hidden"/g)).toHaveLength(1);
  expect(html).toContain('aria-label="More actions"');
});

test("Toolbar.Action uses ARIA key names independently of shortcut cap labels", () => {
  for (const [keys, expected] of [
    ["mod+j", "Control+J"],
    ["ctrl+alt+shift+meta+x", "Control+Alt+Shift+Meta+X"],
    ["shift+arrowdown", "Shift+ArrowDown"],
    ["arrowup", "ArrowUp"],
    ["esc", "Escape"],
    ["backspace", "Backspace"],
    ["enter", "Enter"],
    ["delete", "Delete"],
    ["space", "Space"],
    ["+", "plus"],
    ["mod++", "Control+plus"],
    ["", undefined],
    ["mod", undefined],
    ["ctrl+", undefined],
    ["unknown+e", undefined],
    ["not-a-key", undefined],
  ] as const) {
    const html = renderToString(() => createComponent(Toolbar.Action, { label: "Action", icon: "ti ti-check", keys }));
    if (expected) expect(html).toContain(`aria-keyshortcuts="${expected}"`);
    else expect(html).not.toContain("aria-keyshortcuts=");
  }
});

test("Toolbar inherits the More label and shortcut tooltip locale without translating ARIA key names", () => {
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(Toolbar, {
          label: "Auswahl",
          variant: "floating",
          get children() {
            return createComponent(Toolbar.Action, { label: "Assistent", icon: "ti ti-sparkles", keys: "mod+j", priority: 1 });
          },
        });
      },
    }),
  );
  expect(html).toContain('aria-label="Weitere Aktionen"');
  expect(html).toContain('title="Assistent (Strg+J)"');
  expect(html).toContain('aria-keyshortcuts="Control+J"');
});

describe("workspace head navigation", () => {
  const items = Array.from({ length: 8 }, (_, index) => ({
    id: String(index + 1),
    label: `View ${index + 1}`,
    href: `?view=${index + 1}`,
    count: index,
  }));
  test("overflow replaces the last slot with the current view at both levels", () => {
    expect(viewTabsLayout(items, "7")).toEqual({ wide: [0, 1, 2, 3, 6], compact: [0, 1, 6], wideHidden: 3, compactHidden: 5 });
    expect(viewTabsLayout(items, "missing").wide).toEqual([0, 1, 2, 3, 4]);
    expect(viewTabsLayout(items.slice(0, 2), "2")).toEqual({ wide: [0, 1], compact: [0, 1], wideHidden: 0, compactHidden: 0 });
    expect(viewTabsLayout(items, "8", 2)).toEqual({ wide: [0, 7], compact: [0, 7], wideHidden: 6, compactHidden: 6 });
    expect(viewTabsLayout([], undefined)).toEqual({ wide: [], compact: [], wideHidden: 0, compactHidden: 0 });
    for (const max of [0, -1, NaN, Infinity]) expect(viewTabsLayout(items, "7", max).wide).toContain(6);
  });
  test("SSR renders ordinary view links and both CSS overflow levels", () => {
    const html = renderToString(() => createComponent(ViewTabs, { label: "Views", items, current: "7", class: "custom" }));
    expect(html).toContain('class="k2b-view-tabs custom" aria-label="Views"');
    expect(html).toMatch(/<ul[^>]*class="k2b-view-tabs__list"[^>]*data-scroll-fade-mode="both"[^>]*data-scroll-fade-axis="horizontal"/);
    expect(html).toContain("<script>(function watchViewTabs(");
    expect([...html.matchAll(/data-view-tab="([^"]+)"/g)].map((match) => match[1])).toEqual(["1", "2", "3", "4", "7"]);
    expect(html.match(/data-compact-hidden=""/g)).toHaveLength(2);
    expect(html).toContain('data-wide=""');
    // The count's own span, whatever hydration markers precede the text.
    const moreCount = (level: string) => html.split(`data-level="${level}">`)[1]?.split("</span>")[0];
    expect(moreCount("wide")).toEndWith("+3");
    expect(moreCount("compact")).toEndWith("+5");
    expect(html).toMatch(/href="\?view=7" aria-current="page"/);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html.match(/<a /g)).toHaveLength(5);
    expect(html).not.toContain('role="tab');
    expect(html).not.toContain("tabindex=");
    expect(renderToString(() => createComponent(ViewTabs, { label: "Views", items, current: "unknown" }))).not.toMatch(
      /<a[^>]*aria-current=/,
    );
    const de = renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "de",
        get children() {
          return createComponent(ViewTabs, { label: "Ansichten", items, current: "7" });
        },
      }),
    );
    expect(de).toContain('aria-label="Weitere Ansichten"');
    expect(de).toContain(">Weitere<");
  });
  test("with showValue, active chips name the first option in section order and show additional values", () => {
    const chip = (value: string[], isActive?: boolean, showValue = true) =>
      renderToString(() =>
        createComponent(FilterChip, {
          label: "Tags",
          icon: "ti ti-tag",
          value,
          isActive,
          showValue,
          onValueChange: () => {},
          options: [
            {
              multiple: true,
              options: [
                { value: "customer", label: "Customer", color: "#123456" },
                { value: "urgent", label: "Urgent" },
              ],
            },
            { options: [{ value: "internal", label: "Internal" }] },
          ],
        }),
      );
    const one = chip(["customer"]);
    expect(one).toContain('aria-label="Tags: Customer"');
    expect(one).toContain('class="k2b-filter-chip__value"');
    expect(one).toContain('class="k2b-filter-chip__dot" style="--k2b-filter-color:#123456" aria-hidden="true"');
    expect(chip(["internal", "urgent", "customer"])).toContain('aria-label="Tags: Customer +2"');
    for (const html of [chip([]), chip(["customer"], false)]) {
      expect(html).not.toContain('class="k2b-filter-chip__value"');
      expect(html).toContain('aria-label="Tags"');
    }
    // Without showValue an active chip keeps its count, so toolbars built around it keep their geometry.
    const counted = chip(["customer", "urgent"], undefined, false);
    expect(counted).not.toContain('class="k2b-filter-chip__value"');
    expect(counted).toContain("Tags (2)");
    expect(counted).toContain('aria-label="Tags"');
  });
  test("Head slots preserve sibling order at the beginning, middle, and end", () => {
    for (const position of [0, 1, 2]) {
      const html = renderToString(() =>
        createComponent(AppWorkspace, {
          get children() {
            const siblings: JSX.Element[] = ["FIRST CHILD", "SECOND CHILD"];
            siblings.splice(position, 0, createComponent(AppWorkspace.Head, { views: "VIEW SLOT" }));
            return siblings;
          },
        }),
      );
      expect(html).toContain('data-row=""');
      // An explicit head stays where the author declared it, including after
      // object navigation. Only the automatic fallback head is prepended.
      const order = ["FIRST CHILD", "SECOND CHILD"];
      order.splice(position, 0, "VIEW SLOT");
      const positions = order.map((value) => html.indexOf(value));
      expect(positions.every((index) => index >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect(html.match(/class="k2b-app-workspace__head"/g)).toHaveLength(1);
    }
  });
  const workspace = (filtered: boolean, head = true) =>
    renderToString(() =>
      createComponent(PageTrailProvider, {
        trail: { title: "Project", ancestors: [{ title: "Projects", href: "/projects" }] },
        get children() {
          return createComponent(AppWorkspace, {
            get children() {
              return [
                createComponent(AppWorkspace.Content, {
                  get children() {
                    return createComponent(AppWorkspace.Main, { children: "Main content" });
                  },
                }),
                head
                  ? createComponent(AppWorkspace.Head, {
                      views: "VIEW SLOT",
                      filters: "FILTER SLOT",
                      filtered,
                      resetHref: "?view=list",
                      count: "12 results",
                      actions: "SECONDARY",
                      primary: { label: "New task", icon: "ti ti-plus", href: "/new" },
                    })
                  : null,
              ];
            },
          });
        },
      }),
    );
  test("keeps a direct Head after preceding content, with one primary after secondary actions", () => {
    const html = workspace(true);
    expect(html).toContain('data-row=""');
    expect(html.match(/data-workspace-primary=""/g)).toHaveLength(1);
    const order = [
      "Main content",
      "k2b-app-workspace__head-lead",
      "k2b-app-workspace__head-toggle",
      "k2b-page-title",
      "k2b-app-workspace__head-heading",
      "VIEW SLOT",
      "FILTER SLOT",
      "k2b-app-workspace__head-reset",
      "12 results",
      "k2b-app-workspace__head-actions",
      "SECONDARY",
      "data-workspace-primary",
    ];
    const positions = order.map((value) => html.indexOf(value));
    expect(positions.every((index) => index >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html).toMatch(/<a [^>]*href="\?view=list"[^>]*class="[^"]*k2b-app-workspace__head-reset/);
    const unfiltered = workspace(false);
    expect(unfiltered).not.toContain("k2b-app-workspace__head-reset");
    expect(unfiltered).not.toContain("12 results");
    expect(workspace(false, false)).toContain("k2b-app-workspace__head-lead");
    expect(workspace(false, false)).not.toContain("data-row");
  });
  test("shows a zero result count while filtered", () => {
    const html = renderToString(() =>
      createComponent(AppWorkspace, {
        get children() {
          return createComponent(AppWorkspace.Head, { filters: "FILTER SLOT", filtered: true, count: 0 });
        },
      }),
    );
    expect(html).toMatch(/class="k2b-app-workspace__head-count"><span>(?:<!--[^>]*-->)*0/);
  });
  test("constructs each JSX head slot once", () => {
    const reads = { views: 0, filters: 0, actions: 0, count: 0 };
    renderToString(() =>
      createComponent(AppWorkspace, {
        get children() {
          return createComponent(AppWorkspace.Head, {
            filtered: true,
            get views() {
              reads.views++;
              return createComponent(ViewTabs, {
                label: "Views",
                items: [{ id: "list", label: "List", href: "?view=list" }],
                current: "list",
              });
            },
            get filters() {
              reads.filters++;
              return createComponent(FilterChip, {
                label: "Status",
                icon: "ti ti-filter",
                options: [],
                value: [],
                onValueChange: () => {},
              });
            },
            get actions() {
              reads.actions++;
              return createComponent(IconButton, { label: "Refresh", children: "R" });
            },
            get count() {
              reads.count++;
              return createComponent(Button, { children: "Count" });
            },
          });
        },
      }),
    );
    expect(reads).toEqual({ views: 1, filters: 1, actions: 1, count: 1 });
  });
  test("omits absent head slots and counts, with actions for a primary alone", () => {
    for (const count of [undefined, null, false]) {
      const html = renderToString(() =>
        createComponent(AppWorkspace, {
          get children() {
            return createComponent(AppWorkspace.Head, {
              views: false,
              filters: false,
              actions: false,
              filtered: true,
              count,
              primary: { label: "New task", icon: "ti ti-plus", href: "/new" },
            });
          },
        }),
      );
      expect(html).not.toContain("k2b-app-workspace__head-views");
      expect(html).not.toContain("k2b-app-workspace__head-count");
      expect(html).toContain("k2b-app-workspace__head-reset");
      expect(html).toContain("k2b-app-workspace__head-actions");
      expect(html.match(/data-workspace-primary=""/g)).toHaveLength(1);
    }
  });
});

describe("FilterToggle", () => {
  test("renders an active or inactive filter as a native link", () => {
    for (const active of [true, false]) {
      const html = renderToString(() =>
        createComponent(FilterToggle, {
          href: "/users?recursive=true",
          label: "All members",
          icon: "ti ti-hierarchy",
          active,
        }),
      );
      expect(html).toStartWith("<a ");
      expect(html).toContain('href="/users?recursive=true"');
      expect(html).toContain('class="k2b-filter-chip ');
      expect(html.includes('aria-current="true"')).toBe(active);
      expect(html.includes('data-active="true"')).toBe(active);
      expect(html).not.toContain("aria-pressed");
      expect(html).not.toContain("data-variant");
      if (!active) {
        expect(html).not.toContain("data-active=");
        expect(html).not.toContain("aria-current=");
      }
    }
  });

  test("renders a button with pressed state, including a disabled link", () => {
    for (const active of [true, false]) {
      const html = renderToString(() => createComponent(FilterToggle, { label: "Only mine", icon: "ti ti-user", active }));
      expect(html).toStartWith("<button ");
      expect(html).toContain('type="button"');
      expect(html).toContain(`aria-pressed="${active}"`);
      expect(html.includes('data-active="true"')).toBe(active);
      expect(html).not.toContain("aria-current");
    }
    const disabled = renderToString(() =>
      createComponent(FilterToggle, {
        href: "/users?recursive=true",
        label: "All members",
        icon: "ti ti-hierarchy",
        active: true,
        disabled: true,
      }),
    );
    expect(disabled).toStartWith("<button ");
    expect(disabled).toContain('type="button"');
    expect(disabled).toContain(" disabled");
    expect(disabled).not.toContain("href=");
  });

  test("uses the shared active FilterChip tint and keeps links undecorated", () => {
    const active = rule('.k2b-ui .k2b-filter-chip[data-active="true"]');
    expect(active).toContain("background: var(--k2b-app-workspace-selected)");
    expect(active).toContain("color: var(--k2b-app-workspace-active)");
    expect(rule(".k2b-ui a.k2b-filter-chip")).toContain("text-decoration: none");
  });
});

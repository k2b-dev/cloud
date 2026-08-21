import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { DropdownItem as PublicDropdownItem } from "../index";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-actions-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const {
  Button,
  ButtonLink,
  ContextMenu,
  CopyButton,
  Disclosure,
  Dropdown,
  dropdownPosition,
  FilterChip,
  IconButton,
  IconButtonLink,
  isSpotlightShortcut,
  RemoveButton,
  SegmentedControl,
  SplitButton,
  SpotlightButton,
  Tabs,
  Toolbar,
} = await import("../index");
const { copyText } = await import("./CopyButton");
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
            createComponent(Toolbar.Group, { label: "Edit", children: "Actions" }),
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
    expect(toolbar).toContain('role="toolbar"');
    expect(toolbar).toContain('aria-label="Document actions"');
    expect(toolbar).toContain('role="separator"');
    expect(toolbar).toContain('role="separator" aria-orientation="vertical" data-orientation="vertical"');
    expect(verticalToolbar).toContain('role="separator" aria-orientation="horizontal" data-orientation="horizontal"');
    expect(rule(".k2b-ui .k2b-disclosure")).toContain("width: 100%");
    expect(rule(".k2b-ui .k2b-disclosure")).toContain("align-self: stretch");
    expect(rule(".k2b-ui .k2b-disclosure > summary")).toContain("user-select: none");
    expect(actionsCss).not.toContain(".k2b-disclosure > summary:hover { background:");
    expect(actionsCss).toContain(".k2b-disclosure > summary:hover .k2b-disclosure__chevron");
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
    expect(rule('.k2b-ui .k2b-button[data-variant="subtle"]')).toContain("background: var(--k2b-surface-muted)");
    const warningRule = rule('.k2b-ui .k2b-button[data-variant="warning"]');
    expect(warningRule).toContain("color: #422006");
    expect(warningRule).toContain("background: var(--k2b-warning-500)");
    expect(rule('.k2b-ui .k2b-button[data-variant="danger"]:not(:disabled):hover')).toContain(
      "background: color-mix(in srgb, var(--k2b-danger-600) 86%, #000000)",
    );
    expect(rule('.k2b-ui .k2b-button[data-variant="success"]:not(:disabled):hover')).toContain(
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
    expect(inputRule).toContain("background: var(--k2b-surface-muted)");
    expect(rule('.k2b-ui .k2b-icon-button[data-variant="input"]')).toContain("width: 2.25rem");
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
    const hoverRule = rule('.k2b-ui .k2b-button[data-variant="text"]:not(:disabled):hover');
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

  test("applies the dropdown width as a real CSS length, not a class name", () => {
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
    expect(sized).not.toContain('class="k2b-dropdown__menu 10rem');
    expect(unsized).not.toContain("--k2b-dropdown-width");
    // The default stays in CSS, and nothing may clamp a narrower request.
    expect(actionsCss).toContain("width: var(--k2b-dropdown-width, 12rem)");
    const menu = rule(".k2b-ui .k2b-dropdown__menu");
    expect(menu).not.toContain("min-width:");
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

  test("renders accessor-based segmented controls with source dividers and full-width layout", () => {
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
    expect(html).toContain('data-divider="true"');
    // Layout and dividers belong to the stylesheet: Cloud sizes the segments with
    // `flex-1` and draws the divider as an inset pseudo element, so no inline
    // style may leak geometry into the markup.
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

  test("recognizes the cross-platform spotlight shortcut", () => {
    expect(isSpotlightShortcut({ metaKey: true, ctrlKey: false, shiftKey: true, key: "K" } as KeyboardEvent)).toBe(true);
    expect(isSpotlightShortcut({ metaKey: false, ctrlKey: true, shiftKey: true, key: "k" } as KeyboardEvent)).toBe(true);
    expect(isSpotlightShortcut({ metaKey: true, ctrlKey: false, shiftKey: false, key: "k" } as KeyboardEvent)).toBe(false);
  });

  test("keeps an icon button quiet by default, like Cloud's icon-btn utility", () => {
    const implicit = renderToString(() => createComponent(IconButton, { label: "Settings", children: "S" }));
    const explicit = renderToString(() => createComponent(IconButton, { label: "Save", variant: "primary", children: "S" }));

    expect(implicit).toContain('data-variant="ghost"');
    expect(implicit).toContain('aria-label="Settings"');
    expect(implicit).toContain('title="Settings"');
    expect(explicit).toContain('data-variant="primary"');
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
    expect(html).not.toContain("save icon");
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
  test("segments keep Cloud's control-sized, flex-1 geometry with an inset divider", () => {
    const control = rule(".k2b-ui .k2b-segmented-control");
    const option = rule(".k2b-ui .k2b-segmented-control__option");

    expect(control).toContain("w-full");
    expect(control).toContain("items-stretch");
    expect(control).toContain("padding: 0.125rem");
    expect(option).toContain("flex-1");
    expect(option).toContain("min-height: 2rem");
    expect(option).toContain("padding: 0.25rem 0.5rem");
    expect(option).not.toContain("font-weight");
    expect(actionsCss).toContain('.k2b-ui .k2b-segmented-control__option[data-divider="true"]::after');
    expect(actionsCss).toContain(".k2b-ui .k2b-segmented-control__option:not(:disabled):hover");
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
    expect(chip).toContain("padding: 0.375rem 0.75rem");
    expect(chip).toContain("background: var(--k2b-surface-muted)");
    expect(iconOnly).toContain("width: 2.25rem");
    expect(actionsCss).toContain(".k2b-ui .k2b-filter-chip:hover");
  });

  test("buttons use flat, layout-stable press feedback", () => {
    const button = rule(".k2b-ui .k2b-button");
    const active = rule(".k2b-ui .k2b-button:not(:disabled):active");
    const split = rule(".k2b-ui .k2b-dropdown.k2b-split-button");
    const splitSegmentActive = rule(".k2b-ui .k2b-split-button > .k2b-button:not(:disabled):active");
    const splitPrimaryActive = rule(
      ".k2b-ui .k2b-dropdown.k2b-split-button:has(> .k2b-split-button__primary:not(:disabled):active)",
    );
    const disabled = rule(".k2b-ui .k2b-button:disabled");

    expect(button).toContain("transition:");
    expect(button).toContain("user-select: none");
    expect(button).toContain("font-weight: 500");
    expect(active).toContain("scale: 0.98");
    expect(active).not.toContain("box-shadow");
    expect(split).toContain("transition: scale 100ms ease-out");
    expect(splitSegmentActive).toContain("scale: none");
    expect(splitPrimaryActive).toContain("scale: 0.98");
    expect(actionsCss).not.toContain(
      ".k2b-ui .k2b-dropdown.k2b-split-button:has(> .k2b-button:not(:disabled):active)",
    );
    expect(actionsCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(disabled).toContain("opacity: 0.4");
  });
});

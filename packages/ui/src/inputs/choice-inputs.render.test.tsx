import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent, createRoot } from "solid-js";
import { renderToString } from "solid-js/web";
import { createChoiceLoader, filterChoiceOptions, nextEnabledChoiceIndex, placeChoicePopover } from "./choice";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-choice-inputs-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { Checkbox } = await import("./Checkbox");
const { CheckboxCard } = await import("./CheckboxCard");
const { ColorInput, PinInput, Slider } = await import("./ChoiceInputs");
const { Combobox } = await import("./Combobox");
const { MultiSelectInput } = await import("./MultiSelectInput");
const { Select } = await import("./Select");
const { SelectChip } = await import("./SelectChip");
const { NumberInput } = await import("./NumberInput");
const { Switch } = await import("./Switch");
const { TagsInput } = await import("./TagsInput");
const { TagEditor } = await import("./TagEditor");
const { TextInput } = await import("./TextInput");

const indexCss = await Bun.file(resolve(import.meta.dir, "../styles/index.css")).text();
/** Body of the first top-level rule whose selector line starts with `selector`. */
const cssRule = (selector: string): string => {
  const start = indexCss.indexOf(`\n${selector} {`);
  if (start < 0) return "";
  const open = indexCss.indexOf("{", start);
  const close = indexCss.indexOf("}", open);
  return indexCss.slice(open + 1, close);
};

test("choice controls keep descenders inside clipped single-line labels", () => {
  expect(cssRule(".k2b-ui .k2b-choice-trigger,\n.k2b-ui .k2b-multi-select-trigger,\n.k2b-ui .k2b-combobox__input")).toContain(
    "line-height: 1rem",
  );
  expect(cssRule(".k2b-ui .k2b-choice-option")).toContain("line-height: 1rem");
  expect(cssRule(".k2b-ui .k2b-choice-pill")).toContain("line-height: 1rem");
});

test("input clear actions stay minimal and use danger text on hover", () => {
  expect(cssRule(".k2b-ui .k2b-input-clear-action")).toContain("background: transparent");
  const hover = cssRule(".k2b-ui .k2b-input-clear-action:hover");
  expect(hover).toContain("color: var(--k2b-danger-text)");
  expect(hover).toContain("background: transparent");
});

const options = [
  {
    value: "platform",
    label: "Platform",
    description: "Runtime and infrastructure",
    icon: "ti ti-server",
  },
  { value: "disabled", label: "Disabled", disabled: true },
  { value: "design", label: "Design System", description: "Product UI" },
] as const;

describe("@k2b/ui complete choice input migrations", () => {
  test("renders a controlled tag manager without persistence assumptions", () => {
    const html = renderToString(() =>
      createComponent(TagEditor, {
        items: [{ id: "ui", name: "UI", color: "#06b6d4" }],
        onCreate: () => {},
        onUpdate: () => {},
        onDelete: () => {},
      }),
    );

    expect(html).toContain("k2b-tag-editor");
    expect(html).toContain("UI");
    expect(html).toContain("Edit UI");
    expect(html).toContain("Delete UI");
    expect(html).toContain("Add tag");
    expect(cssRule(".k2b-ui .k2b-tag-editor__fields button.k2b-color-input__swatch")).toContain("width: 2.25rem");
    expect(cssRule(".k2b-ui .k2b-tag-editor__fields button.k2b-color-input__swatch")).toContain("height: 2.25rem");
  });

  test("renders checkbox, card, and switch semantics", () => {
    const checkbox = renderToString(() =>
      createComponent(Checkbox, {
        label: "Accept updates",
        description: "Monthly product notes",
        error: () => "Required",
        required: true,
        value: () => false,
      }),
    );
    const card = renderToString(() =>
      createComponent(CheckboxCard, {
        label: "Early access",
        description: "Preview components",
        icon: "ti ti-flask",
        value: () => true,
      }),
    );
    const toggle = renderToString(() => createComponent(Switch, { label: "Automation", value: () => true }));

    expect(checkbox).toContain('aria-invalid="true"');
    expect(checkbox).toContain('role="alert"');
    expect(checkbox).toContain("k2b-field__required");
    expect(card).toContain('data-state="checked"');
    expect(card).toContain("ti ti-flask");
    expect(cssRule('.k2b-ui .k2b-checkbox-card[data-state="checked"]')).toContain("border-color: var(--k2b-action)");
    expect(cssRule('.k2b-ui .k2b-checkbox-card[data-state="checked"]')).not.toContain("background");
    expect(toggle).toContain('role="switch"');
    expect(toggle).toContain("checked");

    const requiredToggle = renderToString(() => createComponent(Switch, { label: "Automation", required: true, value: false }));
    expect(requiredToggle).toContain("required");
    expect(requiredToggle).toContain("k2b-field__required");
    expect(checkbox).toContain("required");
  });

  test("renders a control-only mixed checkbox for bulk selection", () => {
    const html = renderToString(() =>
      createComponent(Checkbox, {
        "aria-label": "Select visible records",
        indeterminate: true,
        value: () => false,
      }),
    );

    expect(html).toContain('aria-label="Select visible records"');
    expect(html).toContain('aria-checked="mixed"');
    expect(html).toContain('data-indeterminate="true"');
    expect(html).toContain("ti ti-minus");
    expect(html).not.toContain("k2b-check__content");
  });

  test("renders a searchable select with descriptions, disabled options, and clear state", () => {
    const html = renderToString(() =>
      createComponent(Select, {
        label: "Team",
        value: () => "platform",
        options: options.map((option) => ({ id: option.value, ...option })),
        clearable: true,
      }),
    );

    expect(html).toContain('role="combobox"');
    expect(html).toContain('popover="manual"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("Runtime and infrastructure");
    expect(html).toContain("Clear selection");
    expect(html).toContain("k2b-input-clear-action");
    expect(html).not.toContain("ti ti-chevron-down");
    expect(html).toContain("disabled");
    expect(cssRule(".k2b-ui .k2b-choice-popover")).toContain("transition: none");
  });

  test("renders overlapping Select groups with an initial group filter", () => {
    const html = renderToString(() =>
      createComponent(Select, {
        label: "Icon",
        value: "briefcase",
        searchable: true,
        groups: [
          { value: "recommended", label: "Recommended" },
          { value: "food", label: "Food" },
          { value: "work", label: "Work" },
        ],
        defaultGroup: "recommended",
        options: [
          { value: "coffee", label: "Coffee", groups: ["recommended", "food"] },
          { value: "briefcase", label: "Briefcase", groups: ["recommended", "work"] },
          { value: "pizza", label: "Pizza", groups: ["food"] },
        ],
      }),
    );

    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Filter options"');
    expect(html).toContain('role="radio" aria-checked="true"');
    expect(html).toContain(">Recommended</button>");
    expect(html).toContain(">Coffee</strong>");
    expect(html).toContain(">Briefcase</strong>");
    expect(html).not.toContain(">Pizza</strong>");
    expect(cssRule(".k2b-ui .k2b-choice-groups")).toContain("overflow-x: auto");
    expect(cssRule(".k2b-ui .k2b-choice-groups")).toContain("scrollbar-width: none");
    expect(cssRule(".k2b-ui .k2b-choice-groups-scrollbar")).toContain("position: absolute");
    expect(cssRule(".k2b-ui .k2b-choice-groups-scrollbar")).toContain("pointer-events: none");
    expect(cssRule(".k2b-ui .k2b-choice-groups-scrollbar > span")).toContain("width: var(--k2b-choice-scroll-width)");
  });

  test("renders an optional grid view toggle with a configurable default and tile size", () => {
    const html = renderToString(() =>
      createComponent(Select, {
        label: "Icon",
        value: "coffee",
        viewToggle: true,
        defaultView: "grid",
        gridSize: "sm",
        options: [
          { value: "coffee", label: "Coffee", description: "Drinks and breaks", icon: "ti ti-coffee" },
          { value: "pizza", label: "Pizza", description: "Meals and restaurants", icon: "ti ti-pizza" },
        ],
      }),
    );

    expect(html).toContain("k2b-choice-toolbar");
    expect(html).toContain('aria-label="Show list view"');
    expect(html).toContain("ti ti-list-details");
    expect(html).not.toContain("ti ti-category-2");
    expect(html).toContain('data-view="grid" data-grid-size="sm"');
    expect(cssRule('.k2b-ui .k2b-choice-options[data-view="grid"]')).toContain("grid-template-columns");
    expect(cssRule('.k2b-ui .k2b-choice-options[data-view="grid"] > .k2b-choice-option strong')).toContain("color: var(--k2b-text-muted)");
    expect(cssRule('.k2b-ui .k2b-choice-options[data-view="grid"] > .k2b-choice-option strong')).toContain("font-weight: 400");
    expect(cssRule(".k2b-ui .k2b-choice-view-toggle")).toContain("margin-left: auto");
    expect(cssRule(".k2b-ui .k2b-choice-view-toggle")).toContain("background: transparent");
    expect(cssRule(".k2b-ui .k2b-choice-view-toggle:hover")).toContain("color: var(--k2b-action)");
  });

  test("keeps the existing list view free of layout controls by default", () => {
    const html = renderToString(() =>
      createComponent(Select, {
        label: "Status",
        value: "open",
        options: [{ value: "open", label: "Open" }],
      }),
    );

    expect(html).toContain('data-view="list"');
    expect(html).not.toContain("k2b-choice-view-toggle");
  });

  test("does not render a stale selectedOption for a different controlled value", () => {
    const html = renderToString(() =>
      createComponent(Select, {
        label: "Team",
        value: "platform",
        options: [],
        selectedOption: { value: "design", label: "Design" },
      }),
    );

    expect(html).toContain("platform");
    expect(html).not.toContain(">Design<");
  });

  test("renders consume-and-clear combobox suggestions", () => {
    const html = renderToString(() =>
      createComponent(Combobox, {
        label: "Add member",
        placeholder: "Search people",
        fetchData: async () => options.map((option) => ({ id: option.value, ...option })),
        onSelect: () => {},
      }),
    );

    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Search people");
    // Assert the aria-controls relationship, not a literal id: field ids come
    // from a module-global createUniqueId() counter, so pinning "k2b-field-00"
    // breaks whenever a test is inserted before this one.
    const controls = html.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controls).toMatch(/^k2b-field-\d+-listbox$/);
    expect(html).toContain(`id="${controls}"`);
    expect(html).toContain("Type to search...");
    expect(cssRule(".k2b-ui .k2b-combobox__input > i:first-child")).toContain("margin-inline: 0.625rem 0");
    expect(cssRule(".k2b-ui .k2b-combobox__input > i:last-child")).toContain("margin-inline: 0 0.625rem");
  });

  test("renders multi-select values and listbox state", () => {
    const html = renderToString(() =>
      createComponent(MultiSelectInput, {
        label: "Teams",
        value: () => ["platform", "design"],
        options: options.map((option) => ({
          id: option.value,
          ...option,
          color: option.value === "platform" ? "#0891b2" : undefined,
        })),
        clearable: true,
      }),
    );

    expect(html).toContain('aria-multiselectable="true"');
    expect(html).toContain("k2b-choice-pill");
    expect(html).toContain("Remove Platform");
    expect(html).toContain("--k2b-choice-background:#0891b21f");
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-label="Platform"');
    expect(html).toContain("Clear selection");
    expect(html).toContain("k2b-input-clear-action");
    expect(html).not.toContain("k2b-multi-select-trigger__chevron");
    expect(html).toContain("<strong>Platform</strong><small>Runtime and infrastructure</small>");
    expect(html).not.toContain("<span><strong>Platform</strong><small>Runtime and infrastructure</small></span>");
  });

  test("renders overlapping MultiSelectInput groups with an initial filter", () => {
    const html = renderToString(() =>
      createComponent(MultiSelectInput, {
        label: "Icons",
        value: ["briefcase"],
        groups: [
          { value: "recommended", label: "Recommended" },
          { value: "food", label: "Food" },
          { value: "work", label: "Work" },
        ],
        defaultGroup: "recommended",
        options: [
          { id: "coffee", label: "Coffee", groups: ["recommended", "food"] },
          { id: "briefcase", label: "Briefcase", groups: ["recommended", "work"] },
          { id: "pizza", label: "Pizza", groups: ["food"] },
        ],
      }),
    );

    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('role="radio" aria-checked="true"');
    expect(html).toContain(">Recommended</button>");
    expect(html).toContain(">Coffee</strong>");
    expect(html).toContain(">Briefcase</strong>");
    expect(html).not.toContain(">Pizza</strong>");
  });

  test("keeps composite field labels out of invalid HTML for targets", () => {
    const multi = renderToString(() => createComponent(MultiSelectInput, { label: "Teams", value: [], options: [] }));
    const tags = renderToString(() => createComponent(TagsInput, { label: "Tags", value: [] }));
    const pin = renderToString(() => createComponent(PinInput, { label: "PIN", value: "", length: 4 }));

    for (const html of [multi, tags, pin]) {
      expect(html).toContain('aria-labelledby="');
      expect(html).not.toMatch(/<label[^>]+for="k2b-field-/);
    }
  });

  test("lets applications render domain-specific multi-select labels", () => {
    const html = renderToString(() =>
      createComponent(MultiSelectInput, {
        label: "Teams",
        value: () => ["platform"],
        options: [{ id: "platform", label: "Platform", color: "#0891b2" }],
        renderValue: (option) => `Selected ${option.label}`,
        renderOption: (option) => `Option ${option.label}`,
      }),
    );

    expect(html).toContain("Selected Platform");
    expect(html).toContain("Option Platform");
    expect(html).toContain('class="k2b-choice-dot"');
    expect(html).toContain("background:#0891b2");
  });

  test("renders tags as removable values and form entries", () => {
    const html = renderToString(() =>
      createComponent(TagsInput, {
        label: "Tags",
        value: () => ["solid", "ssr"],
      }),
    );

    expect(html).toContain("solid");
    expect(html).toContain('type="text"');
    expect(html).toContain('role="status"');
    expect(html).toContain("k2b-tags-input__icon-idle");
    expect(html).toContain("ti ti-pencil k2b-tags-input__icon-active");
    expect(html).toContain("k2b-tags-input__values");
  });

  test("renders select chips through the accessible dropdown contract", () => {
    const html = renderToString(() =>
      createComponent(SelectChip, {
        value: "comfortable",
        onValueChange: () => {},
        "aria-label": "Density",
        options: [
          { value: "compact", label: "Compact" },
          { value: "comfortable", label: "Comfortable" },
        ],
      }),
    );

    expect(html).toContain("k2b-select-chip");
    expect(html).toContain('role="menu"');
    expect(html).toContain('role="menuitemradio"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("Comfortable");
    expect(html).toContain("Compact");
    // Cloud opens this menu at `w-40`, and marks the current option with a
    // trailing check rather than a leading icon.
    expect(html).toContain("--k2b-dropdown-width:10rem");
    expect(html).toContain("k2b-select-chip__option");
    expect(html).toContain('<span class="k2b-dropdown__copy"><span>Comfortable</span></span><i class="ti ti-check k2b-dropdown__check"');
    expect(html).not.toContain('<i class="ti ti-check" aria-hidden="true"></i><span>Comfortable');
  });

  test("renders compact rich options without consumer-owned menu rows", () => {
    const html = renderToString(() =>
      createComponent(SelectChip, {
        value: "fast",
        onValueChange: () => {},
        "aria-label": "Model",
        menuWidth: "15rem",
        options: [
          {
            value: "fast",
            label: "Fast model",
            description: "Low latency",
            image: "https://example.test/provider.svg",
          },
        ],
      }),
    );

    expect(html).toContain("--k2b-dropdown-width:15rem");
    expect(html).toContain('src="https://example.test/provider.svg"');
    expect(html).toContain("Low latency");
    expect(html).toContain("k2b-dropdown__copy");
  });

  test("renders navigable PIN digits instead of one opaque text field", () => {
    const html = renderToString(() =>
      createComponent(PinInput, {
        label: "Access code",
        description: "Six digits",
        value: () => "123",
        length: 6,
        required: true,
        stretch: true,
      }),
    );

    expect(html.match(/class="k2b-control k2b-pin-input__digit"/g)).toHaveLength(6);
    expect(html).toContain('aria-label="PIN digit 1 of 6"');
    expect(html).toContain('autocomplete="off"');
    expect(html).toContain('data-stretch="true"');
    const groupLabelId = html.match(/role="group"[^>]*aria-labelledby="([^"]+)"/)?.[1];
    expect(groupLabelId).toBeTruthy();
    expect(html).toContain(`id="${groupLabelId}"`);
  });

  test("renders slider value, center track, and reset-capable range semantics", () => {
    const html = renderToString(() =>
      createComponent(Slider, {
        label: "Balance",
        value: () => -25,
        onValueChange: () => {},
        min: -100,
        max: 100,
        center: true,
        defaultValue: 0,
        formatValue: (value) => `${value}%`,
      }),
    );

    expect(html).toContain('type="range"');
    expect(html).toContain("linear-gradient");
    expect(html).toContain("-25%");
    expect(html).toContain("<output");
  });

  test("renders compact and transparent-capable color controls", () => {
    const compact = renderToString(() =>
      createComponent(ColorInput, {
        "aria-label": "Choose color",
        value: () => "#123456",
        compact: true,
      }),
    );
    const full = renderToString(() =>
      createComponent(ColorInput, {
        label: "Surface",
        value: () => "#123456",
        transparent: true,
        transparentValue: () => true,
      }),
    );

    expect(compact).toContain("k2b-color-input--compact");
    expect(compact).toContain('aria-label="Choose color"');
    expect(full).toContain("transparent");
    expect(full).toContain('aria-pressed="true"');
    expect(full).toContain('data-transparent="true"');
  });

  test("describes a field above its control, like the Cloud input wrapper", () => {
    const html = renderToString(() =>
      createComponent(PinInput, {
        label: "Access code",
        description: "Six digits",
        error: () => "Wrong code",
        value: () => "1",
      }),
    );

    const label = html.indexOf("k2b-field__label");
    const description = html.indexOf("k2b-field__description");
    const control = html.indexOf("k2b-pin-input");
    const error = html.indexOf("k2b-field__error");

    expect(label).toBeGreaterThan(-1);
    expect(description).toBeGreaterThan(label);
    expect(control).toBeGreaterThan(description);
    expect(error).toBeGreaterThan(control);
  });

  test("keeps the checkbox card label in the content column with or without a glyph", () => {
    const plain = renderToString(() => createComponent(CheckboxCard, { label: "Early access", value: false }));
    const withIcon = renderToString(() =>
      createComponent(CheckboxCard, {
        label: "Early access",
        value: false,
        icon: "ti ti-flask",
      }),
    );
    const withColor = renderToString(() => createComponent(CheckboxCard, { label: "Early access", value: false, color: "#123456" }));

    // Two grid items (control + content) against a two-column template: an icon
    // must not claim a column of its own, or a card without one indents its label.
    expect(cssRule(".k2b-ui .k2b-checkbox-card")).toContain("grid-template-columns: auto minmax(0, 1fr)");
    for (const html of [plain, withIcon, withColor]) {
      expect(html).toContain("k2b-checkbox-card__text");
      expect(html.indexOf("k2b-checkbox-card__content")).toBeLessThan(html.indexOf("k2b-checkbox-card__text"));
    }
    expect(withIcon.indexOf("k2b-checkbox-card__label")).toBeLessThan(withIcon.indexOf("k2b-checkbox-card__icon"));
    expect(withColor.indexOf("k2b-checkbox-card__label")).toBeLessThan(withColor.indexOf("k2b-checkbox-card__color"));
    expect(plain).not.toContain("k2b-checkbox-card__icon");
    expect(plain).not.toContain("k2b-checkbox-card__color");
  });

  test("marks filled pin digits and numeric values by value, not by placeholder", () => {
    const pin = renderToString(() =>
      createComponent(PinInput, {
        value: () => "12",
        length: 4,
        error: () => "Wrong code",
      }),
    );
    const filledNumber = renderToString(() => createComponent(NumberInput, { value: () => 42 }));
    const emptyNumber = renderToString(() => createComponent(NumberInput, { value: () => null }));

    expect(pin.match(/data-filled="true"/g)).toHaveLength(2);
    expect(pin.match(/aria-invalid="true"/g)).toHaveLength(1);
    expect(filledNumber).toContain('data-filled="true"');
    expect(emptyNumber).not.toContain("data-filled");
    expect(cssRule(".k2b-ui .k2b-number-input__control")).toContain("text-align: right");
    expect(cssRule(".k2b-ui .k2b-number-input__control::placeholder")).toContain("opacity: 0.65");
    // The mono treatment must key off the value: `:placeholder-shown` never
    // matches when the caller passes no placeholder.
    expect(cssRule('.k2b-ui .k2b-number-input__control[data-filled="true"]')).toContain("font-family: var(--k2b-font-mono)");
  });

  test("integrates NumberInput steppers into one full-width input shell", () => {
    const html = renderToString(() => createComponent(NumberInput, { value: () => 42 }));
    const withoutSteppers = renderToString(() => createComponent(NumberInput, { value: () => 42, showSteppers: false }));

    expect(html).toContain('class="k2b-input-shell k2b-number-input"');
    expect(html).toContain('class="k2b-number-input__value"');
    expect(html.match(/k2b-input-shell/g)).toHaveLength(1);
    expect(withoutSteppers).toContain('class="k2b-input-shell k2b-number-input"');
    expect(withoutSteppers).not.toContain("k2b-number-input__step");
    expect(cssRule(".k2b-ui .k2b-number-input")).toContain("width: 100%");
    expect(cssRule(".k2b-ui .k2b-number-input__step")).toContain("border: 0");
    expect(cssRule(".k2b-ui .k2b-number-input__step:first-child")).toContain("border-right");
    expect(cssRule(".k2b-ui .k2b-number-input__step:last-child")).toContain("border-left");
    expect(cssRule(".k2b-ui .k2b-number-input:focus-within > .k2b-number-input__step")).toContain("var(--k2b-focus-fill)");
    expect(cssRule(".k2b-ui .k2b-number-input__step:hover:not(:disabled)")).toContain("var(--k2b-focus-fill)");
    expect(cssRule(".k2b-ui .k2b-number-input__value > .k2b-input-shell__affix:last-child")).toContain("margin-right: 0.625rem");
  });

  test("sizes a multiline text input from its lines prop", () => {
    const two = renderToString(() => createComponent(TextInput, { label: "Notes", value: "", multiline: true, lines: 2 }));
    const fallback = renderToString(() => createComponent(TextInput, { label: "Notes", value: "", multiline: true }));
    const multilineIcon = cssRule('.k2b-ui .k2b-text-input[data-multiline="true"] .k2b-text-input__icon');

    expect(two).toContain("--k2b-editor-lines:2");
    expect(two).toContain('rows="2"');
    expect(fallback).toContain("--k2b-editor-lines:3");
    expect(cssRule(".k2b-ui .k2b-text-input__textarea")).toContain("var(--k2b-editor-lines, 3)");
    expect(multilineIcon).toContain("height: 1.25rem");
    expect(multilineIcon).toContain("margin-top: 0.375rem");
  });

  test("keeps checkbox, switch and colour geometry aligned with the Cloud controls", () => {
    const check = cssRule(".k2b-ui .k2b-check__control");
    const track = cssRule(".k2b-ui .k2b-switch__track");
    const thumb = cssRule(".k2b-ui .k2b-switch__thumb");
    const colorValue = cssRule(".k2b-ui .k2b-color-input__value");

    expect(check).toContain("width: 1rem");
    expect(check).toContain("border-radius: 0.25rem");
    expect(track).toContain("width: 2.25rem");
    expect(track).toContain("height: 1.25rem");
    expect(thumb).toContain("width: 1rem");
    expect(cssRule(".k2b-ui .k2b-switch > input:checked + .k2b-switch__track .k2b-switch__thumb")).toContain("translateX(1rem)");
    // Colour fields share the 2.25rem box height of every other input shell.
    expect(colorValue).toContain("min-height: 2.25rem");
    expect(cssRule(".k2b-ui .k2b-color-input__transparent")).toContain("height: 2.25rem");
  });

  test("gives steppers, colour buttons and disabled sliders a visible state", () => {
    expect(cssRule(".k2b-ui .k2b-number-input__step:focus-visible")).toContain("var(--k2b-focus-ring)");
    expect(cssRule(".k2b-ui .k2b-slider input:disabled")).toContain("cursor: not-allowed");
    const disabled = renderToString(() =>
      createComponent(Slider, {
        label: "Volume",
        value: () => 10,
        onValueChange: () => {},
        disabled: true,
      }),
    );
    expect(disabled).toContain("disabled");
  });

  test("filters labels, descriptions, and values while skipping disabled keyboard targets", () => {
    expect(filterChoiceOptions(options, "product")).toEqual([options[2]]);
    expect(filterChoiceOptions(options, "platform")).toEqual([options[0]]);
    expect(nextEnabledChoiceIndex(options, 0, 1)).toBe(2);
    expect(nextEnabledChoiceIndex(options, 2, 1)).toBe(0);
    expect(nextEnabledChoiceIndex([{ value: "x", label: "X", disabled: true }], -1, 1)).toBe(-1);
  });

  test("aborts stale async option requests and keeps the latest result", async () => {
    let firstAborted = false;

    await new Promise<void>((resolveTest, rejectTest) => {
      createRoot((dispose) => {
        const loader = createChoiceLoader(
          () =>
            async (query, signal): Promise<readonly { value: string; label: string }[]> => {
              if (query === "first") {
                return await new Promise<readonly { value: string; label: string }[]>((_, reject) => {
                  signal.addEventListener(
                    "abort",
                    () => {
                      firstAborted = true;
                      reject(new DOMException("Aborted", "AbortError"));
                    },
                    { once: true },
                  );
                });
              }
              return [{ value: query, label: query.toUpperCase() }];
            },
          () => 0,
        );

        void (async () => {
          loader.load("first", true);
          await Promise.resolve();
          loader.load("second", true);
          await Bun.sleep(0);

          expect(firstAborted).toBe(true);
          expect(loader.error()).toBeUndefined();
          expect(loader.options()).toEqual([{ value: "second", label: "SECOND" }]);
          dispose();
          resolveTest();
        })().catch((error) => {
          dispose();
          rejectTest(error);
        });
      });
    });
  });

  test("keeps colored options recognizable on the trigger and in the list", () => {
    const html = renderToString(() =>
      createComponent(Select, {
        label: "Tag",
        value: () => "priority",
        options: [{ id: "priority", label: "Priority", color: "#2563eb" }],
      }),
    );

    expect(html).toContain("Priority");
    expect(html).toContain("k2b-choice-dot");
    expect(html.match(/background-color:\s*#2563eb/g)).toHaveLength(2);
  });

  test("treats an empty string as a selectable value", () => {
    const html = renderToString(() =>
      createComponent(Select, {
        label: "Model",
        value: () => "",
        options: [{ id: "", label: "Use default model" }],
      }),
    );

    expect(html).toContain("Use default model");
    expect(html).not.toContain('data-placeholder="true"');
  });

  test("keeps the trigger chevron prop out of the leading decoration slot", () => {
    const html = renderToString(() =>
      createComponent(Select, {
        label: "Sort",
        value: null,
        icon: "ti ti-filter",
        options: [],
        placeholder: "Pick one",
      }),
    );

    expect(html.match(/ti ti-filter/g)).toHaveLength(1);
    expect(html).toContain("Pick one");
  });

  test("reports empty static and searchable option lists with the matching copy", () => {
    const plain = renderToString(() => createComponent(Select, { label: "Team", value: null, options: [] }));
    const searchable = renderToString(() => createComponent(Select, { label: "Team", value: null, options: [], searchable: true }));

    expect(plain).toContain("No options available");
    expect(plain).not.toContain("k2b-choice-search");
    expect(searchable).toContain("No results");
    expect(searchable).toContain("k2b-choice-search");
  });

  test("labels unlabeled selects and submits their value through a named form entry", () => {
    const html = renderToString(() =>
      createComponent(Select, {
        "aria-label": "Select an option",
        name: "team",
        value: () => "platform",
        options: options.map((option) => ({ id: option.value, ...option })),
      }),
    );

    expect(html).toContain('aria-label="Select an option"');
    expect(html).toContain('type="hidden"');
    expect(html).toContain('name="team"');
    expect(html).toContain('value="platform"');
  });

  test("reserves clear-button space only when a clear action is present", () => {
    const plain = renderToString(() =>
      createComponent(Select, {
        label: "Match",
        value: "sender_address",
        options: [{ id: "sender_address", label: "Sender address" }],
      }),
    );
    const clearable = renderToString(() =>
      createComponent(Select, {
        label: "Match",
        value: "sender_address",
        clearable: true,
        options: [{ id: "sender_address", label: "Sender address" }],
      }),
    );

    expect(plain).not.toContain('data-clearable="true"');
    expect(clearable).toContain('data-clearable="true"');
    expect(plain).toContain("ti ti-chevron-down");
    expect(clearable).not.toContain("ti ti-chevron-down");
  });

  test("gives static multi-selects the Cloud search field, chevron props, and pill semantics", () => {
    const html = renderToString(() =>
      createComponent(MultiSelectInput, {
        "aria-label": "Select options",
        class: "project-tags",
        value: () => ["platform"],
        options: options.map((option) => ({ id: option.value, ...option })),
        icon: "ti ti-users",
      }),
    );

    expect(html).toContain("k2b-choice-search");
    expect(html).toContain('placeholder="Search..."');
    expect(html).toContain("ti ti-users k2b-multi-select-trigger__chevron");
    expect(html).toContain('aria-label="Select options"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("k2b-field project-tags");
  });

  test("renders the tags placeholder as muted helper text instead of a value", () => {
    const empty = renderToString(() => createComponent(TagsInput, { label: "Tags", value: () => [] }));
    const filled = renderToString(() => createComponent(TagsInput, { label: "Tags", value: () => ["  solid  "] }));

    expect(empty).toContain("k2b-tags-input__placeholder");
    expect(empty).toContain("Tags (e.g. Tag 1, Tag 2,...)");
    expect(filled).not.toContain("k2b-tags-input__placeholder");
    expect(filled).toContain('<span class="k2b-tag">solid</span>');
  });

  test("sizes choice popovers to their trigger and clamps them into the viewport", () => {
    const originalWindow = globalThis.window;
    Object.assign(globalThis, {
      window: { innerWidth: 1024, innerHeight: 300 },
    });
    try {
      const rect = (values: { left: number; top: number; bottom: number; width: number }) =>
        ({
          ...values,
          right: values.left + values.width,
          height: values.bottom - values.top,
        }) as DOMRect;
      const style: Record<string, string> = {};
      const popover = {
        style,
        getBoundingClientRect: () => ({ height: 200, width: 160 }) as DOMRect,
      } as unknown as HTMLElement;

      placeChoicePopover(
        {
          getBoundingClientRect: () => rect({ left: 900, top: 250, bottom: 280, width: 160 }),
        } as HTMLElement,
        popover,
      );

      // Cloud sizes the panel to the control, with no minimum that would make a
      // narrow trigger open a wider, misaligned dropdown.
      expect(style.width).toBe("160px");
      expect(style.left).toBe("856px");
      expect(style.top).toBe("46px");

      placeChoicePopover(
        {
          getBoundingClientRect: () => rect({ left: 12, top: 10, bottom: 40, width: 96 }),
        } as HTMLElement,
        popover,
      );

      expect(style.width).toBe("96px");
      expect(style.left).toBe("12px");
      expect(style.top).toBe("44px");
    } finally {
      if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else Object.assign(globalThis, { window: originalWindow });
    }
  });

  test("keeps the tags editor aligned with the other controls while it scrolls its caret", async () => {
    const css = await Bun.file(resolve(import.meta.dir, "../styles/index.css")).text();
    const sharedStart = css.indexOf(".k2b-ui .k2b-input-shell,");
    const rule = css.slice(sharedStart, css.indexOf("}", sharedStart));
    const editable = css.match(/\.k2b-ui \.k2b-tags-input > input \{([^}]*)\}/)?.[1] ?? "";

    expect(rule).toMatch(/min-height:\s*2\.25rem/);
    expect(rule).not.toMatch(/flex-wrap/);
    expect(editable).toMatch(/overflow:\s*hidden/);
    expect(editable).toMatch(/overflow-x:\s*auto/);
  });

  test("keeps the native tags editor focusable while pills are visible", () => {
    const hiddenEditor = cssRule(".k2b-ui .k2b-tags-input:not(:focus-within) > input");

    expect(hiddenEditor).not.toMatch(/display:\s*none/);
    expect(hiddenEditor).toMatch(/position:\s*absolute/);
    expect(hiddenEditor).toMatch(/opacity:\s*0/);
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { commitFieldValue } from "./field-contract";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-field-contract-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { Combobox } = await import("./Combobox");
const { AutocompleteEditor } = await import("./AutocompleteEditor");
const { Checkbox } = await import("./Checkbox");
const { CheckboxCard } = await import("./CheckboxCard");
const { ColorInput, PinInput, Slider } = await import("./ChoiceInputs");
const { DatePicker } = await import("./DatePicker");
const { FileDropzone, ImageInput } = await import("./FileInputs");
const { MarkdownEditor } = await import("./markdown/MarkdownEditor");
const { MultiSelectInput } = await import("./MultiSelectInput");
const { NumberInput } = await import("./NumberInput");
const { Select } = await import("./Select");
const { SelectChip } = await import("./SelectChip");
const { IconInput } = await import("./SpecialInputs");
const { Switch } = await import("./Switch");
const { TagsInput } = await import("./TagsInput");
const { TextInput } = await import("./TextInput");

describe("@k2b/ui canonical field contract", () => {
  test("reports an atomic edit as both changed and committed", () => {
    const calls: string[] = [];
    commitFieldValue(
      {
        onValueChange: (value) => calls.push(`change:${value}`),
        onValueCommit: (value) => calls.push(`commit:${value}`),
      },
      "ready",
    );

    expect(calls).toEqual(["change:ready", "commit:ready"]);
  });

  test("connects visible labels, descriptions, errors, and state to the control", () => {
    const html = renderToString(() =>
      createComponent(TextInput, {
        id: "project",
        label: "Project",
        description: "Public name",
        error: () => "Required",
        value: "",
        required: true,
        disabled: true,
      }),
    );

    expect(html).toContain('id="project-label"');
    expect(html).toContain('for="project"');
    expect(html).toContain('aria-labelledby="project-label"');
    expect(html).toContain('aria-describedby="project-description project-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-required="true"');
    expect(html).toContain("disabled");
  });

  test("uses the same native ARIA names across compound controls", () => {
    const controls = [
      renderToString(() => createComponent(Select, { "aria-label": "Team", value: null, options: [] })),
      renderToString(() => createComponent(MultiSelectInput, { "aria-label": "Teams", value: [], options: [] })),
      renderToString(() =>
        createComponent(Combobox, {
          "aria-label": "Add team",
          fetchData: async () => [],
          onSelect: () => {},
        }),
      ),
      renderToString(() => createComponent(TagsInput, { "aria-label": "Tags", value: [] })),
      renderToString(() => createComponent(DatePicker, { "aria-label": "Release date", value: null })),
    ];

    for (const html of controls) {
      expect(html).toContain("aria-label=");
      expect(html).not.toContain("ariaLabel=");
    }
  });

  test("wires the same field metadata across every input family", () => {
    const field = {
      id: "shared",
      label: "Shared label",
      description: "Shared description",
      error: "Shared error",
      required: true,
      disabled: true,
    };
    const controls = [
      renderToString(() => createComponent(TextInput, { ...field, value: "" })),
      renderToString(() => createComponent(NumberInput, { ...field, value: null })),
      renderToString(() => createComponent(Checkbox, { ...field, value: false })),
      renderToString(() => createComponent(CheckboxCard, { ...field, value: false })),
      renderToString(() => createComponent(Switch, { ...field, value: false })),
      renderToString(() => createComponent(Select, { ...field, value: null, options: [] })),
      renderToString(() => createComponent(MultiSelectInput, { ...field, value: [], options: [] })),
      renderToString(() => createComponent(TagsInput, { ...field, value: [] })),
      renderToString(() => createComponent(PinInput, { ...field, value: "" })),
      renderToString(() => createComponent(Slider, { ...field, value: 50 })),
      renderToString(() => createComponent(ColorInput, { ...field, value: "#000000" })),
      renderToString(() => createComponent(DatePicker, { ...field, value: null })),
      renderToString(() =>
        createComponent(Combobox, {
          ...field,
          fetchData: async () => [],
          onSelect: () => {},
        }),
      ),
      renderToString(() => createComponent(SelectChip, { ...field, value: "one", options: [] })),
      renderToString(() => createComponent(AutocompleteEditor, { ...field, value: "" })),
      renderToString(() => createComponent(MarkdownEditor, { ...field, value: "" })),
      renderToString(() => createComponent(FileDropzone, { ...field, onDrop: () => {} })),
      renderToString(() => createComponent(ImageInput, { ...field, value: null })),
      renderToString(() => createComponent(IconInput, { ...field, value: null })),
    ];

    for (const html of controls) {
      expect(html).toContain('id="shared-label"');
      expect(html).toContain('aria-labelledby="shared-label"');
      expect(html).toContain("shared-description");
      expect(html).toContain("shared-error");
      expect(html).toContain('aria-invalid="true"');
      expect(html).toContain("disabled");
    }
  });
});

describe("TextInput icons", () => {
  test("keeps a custom icon while focused and switches only the default icon to the pencil", () => {
    const custom = renderToString(() => createComponent(TextInput, { icon: "ti ti-search", value: "" }));
    const fallback = renderToString(() => createComponent(TextInput, { value: "" }));
    const explicit = renderToString(() => createComponent(TextInput, { icon: "ti ti-search", activeIcon: "ti ti-pencil", value: "" }));

    expect(custom.match(/ti ti-search/g)?.length).toBe(2);
    expect(custom).not.toContain("ti-pencil");
    expect(fallback).toContain("ti ti-cursor-text");
    expect(fallback).toContain("ti ti-pencil");
    expect(explicit).toContain("ti ti-pencil");
  });
});

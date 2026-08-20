import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import {
  abbreviations,
  collectKnownLabels,
  createCompletionBehaviorState,
  detectQuery,
  displayLabel,
  renderWithOverlay,
} from "./completion";
import { clampImageCropRect, getInitialImageCropRect, imageCropRectToPixels, normalizeImageCropRotation } from "./image-crop";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-advanced-inputs-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const {
  AutocompleteEditor,
  FileDropzone,
  IconInput,
  ImageCropper,
  ImageInput,
  MarkdownEditor,
  NumberInput,
  TemplateEditor,
  TemplatePreview,
  TemplateSampleData,
  TextInput,
} = await import("../index");
const editorCss = await Bun.file(resolve(import.meta.dir, "../styles/editors-parity.css")).text();

test("autocomplete options keep descenders inside clipped labels", () => {
  const option = editorCss.match(/\.k2b-ui \.k2b-autocomplete__option \{([^}]*)\}/)?.[1] ?? "";
  const hint = editorCss.match(/\.k2b-ui \.k2b-autocomplete__option small \{([^}]*)\}/)?.[1] ?? "";

  expect(option).toContain("line-height: 1.25rem");
  expect(hint).toContain("line-height: 1rem");
});

describe("@k2b/ui complete advanced input migrations", () => {
  test("detects, labels, renders and applies generic completions", () => {
    const behavior = createCompletionBehaviorState();
    const completion = {
      trigger: "@",
      dropdown: true,
      suggest: () => [{ text: "@alice", hint: "person" }],
    };
    const textarea = {
      value: "Hi @al",
      selectionStart: 6,
      selectionEnd: 6,
      focus() {},
      setSelectionRange(start: number, end: number) {
        this.selectionStart = start;
        this.selectionEnd = end;
      },
    } as HTMLTextAreaElement;
    const context = detectQuery(textarea, [completion]);
    expect(context?.query).toBe("al");
    expect(displayLabel({ text: "@alice" }, completion)).toBe("alice");
    const originalDocument = globalThis.document;
    try {
      globalThis.document = {
        execCommand: (_command: string, _showUi: boolean, value: string) => {
          const start = textarea.selectionStart;
          textarea.value = textarea.value.slice(0, start) + value + textarea.value.slice(textarea.selectionEnd);
          textarea.selectionStart = start + value.length;
          textarea.selectionEnd = textarea.selectionStart;
          return true;
        },
      } as Document;
      expect(behavior.applySuggestion(textarea, context!, { text: "@alice" })).toBe(true);
      expect(textarea.value).toBe("Hi @alice ");
    } finally {
      globalThis.document = originalDocument;
    }
    expect(renderWithOverlay("hello", (value) => value, { ghost: { at: 5, text: " world" } })).toContain("data-completion-anchor");
    const anchoredGhost = renderWithOverlay("Hi @al", (value) => value, {
      anchor: { at: 3 },
      ghost: { at: 6, text: "ice" },
    });
    expect(anchoredGhost).toContain('<span class="k2b-completion-anchor" data-completion-anchor');
    expect(anchoredGhost.indexOf("k2b-completion-anchor")).toBeLessThan(anchoredGhost.indexOf("k2b-completion-ghost"));
    expect(collectKnownLabels([abbreviations({ brb: "be right back" })])).toEqual(new Set(["brb"]));
  });

  test("collects completion metadata without executing providers", () => {
    let calls = 0;
    const labels = collectKnownLabels([
      {
        knownLabels: ["alice", "bob"],
        suggest: () => {
          calls += 1;
          return [];
        },
      },
    ]);

    expect(labels).toEqual(new Set(["alice", "bob"]));
    expect(calls).toBe(0);
  });

  test("renders completion and markdown editor accessibility contracts", () => {
    const autocomplete = renderToString(() =>
      createComponent(AutocompleteEditor, {
        label: "Formula",
        value: "=SUM(",
        completions: [{ trigger: "(", dropdown: true, allowAfterWord: true, suggest: () => [{ text: "(revenue" }] }],
        singleLine: true,
      }),
    );
    const markdown = renderToString(() =>
      createComponent(MarkdownEditor, {
        label: "Notes",
        value: "# Hello",
        abbreviations: { brb: "be right back" },
        onSave: () => {},
      }),
    );

    expect(autocomplete).toContain('aria-haspopup="listbox"');
    expect(autocomplete).not.toContain('role="combobox"');
    expect(autocomplete).toContain('aria-autocomplete="list"');
    expect(autocomplete).toContain("k2b-autocomplete");
    expect(markdown).toContain('role="toolbar"');
    expect(markdown).toContain('aria-label="Bold (Ctrl/Cmd+B)"');
    expect(markdown).toContain("1 line");
    expect(markdown).toContain("2 words");
    expect(markdown).toContain("ti ti-device-floppy");
  });

  test("renders complete text and numeric controls", () => {
    const text = renderToString(() =>
      createComponent(TextInput, {
        label: "Password",
        value: () => "secret",
        password: true,
        prefix: "ID",
        suffix: ".internal",
      }),
    );
    const number = renderToString(() =>
      createComponent(NumberInput, {
        label: "Price",
        value: () => 12.5,
        decimalPlaces: 2,
        prefix: "€",
        suffix: "gross",
        clearable: true,
      }),
    );

    expect(text).toContain('type="password"');
    expect(text).toContain("Show password");
    expect(text).not.toContain("k2b-input-clear-action");
    expect(number).toContain('role="spinbutton"');
    expect(number).toContain('aria-label="Decrease value"');
    expect(number).toContain('aria-label="Increase value"');
    expect(number).toContain("gross");
    expect(number).toContain('aria-label="Clear"');
    expect(number).toContain("k2b-input-clear-action");
  });

  test("renders generic file, image and icon controls", () => {
    const dropzone = renderToString(() =>
      createComponent(FileDropzone, {
        label: "Attachments",
        accept: "image/*",
        multiple: false,
        onDrop: () => {},
      }),
    );
    const image = renderToString(() =>
      createComponent(ImageInput, {
        label: "Avatar",
        value: () => "data:image/png;base64,abc",
        variant: "small",
        round: true,
        onValueChange: () => {},
      }),
    );
    const cropper = renderToString(() =>
      createComponent(ImageCropper, {
        source: "data:image/png;base64,abc",
      }),
    );
    const icon = renderToString(() =>
      createComponent(IconInput, {
        label: "Icon",
        value: "ti ti-home",
      }),
    );

    expect(dropzone).toContain("k2b-dropzone");
    expect(dropzone).toContain("k2b-dropzone__copy");
    expect(dropzone).toContain('accept="image/*"');
    expect(dropzone).not.toContain(" multiple");
    expect(image).toContain('data-variant="small"');
    expect(image).toContain('aria-label="Remove image"');
    expect(image).toContain("ti ti-pencil");
    expect(cropper).toContain("k2b-image-cropper");
    expect(icon).toContain('role="combobox"');
    expect(icon).toContain('role="radiogroup"');
    expect(icon).toContain('aria-label="Show list view"');
    expect(icon).toContain('data-view="grid" data-grid-size="sm"');
    expect(icon).toContain('aria-label="Filter icons"');
    expect(icon).toContain("Recommended");
    expect(icon).toContain("Home");
    expect(icon).toContain("A home page or physical home");
    expect(icon).toContain("ti ti-home");

    const customIcon = renderToString(() =>
      createComponent(IconInput, {
        label: "Custom icon",
        value: null,
        options: [{ value: "ti ti-star", label: "Star", icon: "ti ti-star" }],
      }),
    );
    expect(customIcon).not.toContain('role="radiogroup"');
  });

  test("renders template editor, sandboxed preview and sample data", () => {
    const editor = renderToString(() =>
      createComponent(TemplateEditor, {
        value: "<p>{{ APP_NAME }}</p>",
        variables: [{ name: "APP_NAME", kind: "string" }],
      }),
    );
    const preview = renderToString(() => createComponent(TemplatePreview, { html: "<p>Hello</p>" }));
    const sample = renderToString(() =>
      createComponent(TemplateSampleData, {
        variables: [{ name: "APP_NAME" }],
        values: { APP_NAME: "Cloud" },
        onValueChange: () => {},
      }),
    );

    expect(editor).toContain("k2b-autocomplete");
    expect(preview).toContain("sandbox");
    expect(preview).toContain('title="Template preview"');
    expect(sample).toContain("{{ APP_NAME }}");
    expect(sample).toContain('value="Cloud"');
  });

  test("marks single-line and overlay editors so the stylesheet can size them", () => {
    const single = renderToString(() =>
      createComponent(AutocompleteEditor, {
        label: "Search",
        value: "",
        singleLine: true,
      }),
    );
    const multi = renderToString(() =>
      createComponent(AutocompleteEditor, {
        label: "Notes",
        value: "",
        lines: 5,
        highlight: (text: string) => text,
      }),
    );
    const fillAutocomplete = renderToString(() =>
      createComponent(AutocompleteEditor, {
        label: "Query",
        value: "",
        fill: true,
      }),
    );
    const fillMarkdown = renderToString(() =>
      createComponent(MarkdownEditor, {
        label: "Document",
        value: "",
        fill: true,
      }),
    );

    // Single-line editors are input-height, not one text line tall — folding
    // them into `--k2b-editor-lines: 1` clipped the text against the padding.
    expect(single).toContain('data-single-line="true"');
    expect(single).not.toContain("--k2b-editor-lines:1");
    expect(single).not.toContain('data-overlay="true"');
    expect(single).toContain('class="k2b-autocomplete__preview"');
    expect(single).toContain('rows="1"');
    expect(multi).toContain('data-overlay="true"');
    expect(multi).toContain("--k2b-editor-lines:5");
    expect(multi).toContain('rows="5"');
    expect(fillAutocomplete).toContain('class="k2b-field " data-fill="true"');
    expect(fillAutocomplete).toContain('class="k2b-autocomplete"');
    expect(fillAutocomplete).toContain('data-fill="true"');
    expect(fillMarkdown).toContain('class="k2b-field " data-fill="true"');
    expect(fillMarkdown).toContain('class="k2b-markdown-editor"');
    expect(fillMarkdown).toContain('data-fill="true"');
    const optionsRule = editorCss.match(/\.k2b-ui \.k2b-autocomplete__options \{([^}]*)\}/)?.[1] ?? "";
    expect(optionsRule).toContain("transition: none");
  });

  test("normalizes crop geometry and rotations", () => {
    const initial = getInitialImageCropRect({ width: 1600, height: 900 }, { width: 1, height: 1 });
    expect(initial.width).toBeLessThan(initial.height);
    expect(clampImageCropRect({ x: -1, y: 2, width: 2, height: 0 }, { width: 100, height: 100 })).toEqual({
      x: 0,
      y: 0.92,
      width: 1,
      height: 0.08,
    });
    expect(imageCropRectToPixels({ x: 0.1, y: 0.2, width: 0.5, height: 0.4 }, { width: 1000, height: 500 })).toEqual({
      x: 100,
      y: 100,
      width: 500,
      height: 200,
    });
    expect(normalizeImageCropRotation(-90)).toBe(270);
  });
});

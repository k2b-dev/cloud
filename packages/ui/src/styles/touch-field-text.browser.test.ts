import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { transformAsync } from "@babel/core";
import typescript from "@babel/preset-typescript";
import { createConfig } from "@k2b/ssr";
import solid from "babel-preset-solid";
import type { Browser } from "playwright";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, pageErrors, settled } from "../../test/browser";

// iOS Safari zooms the page when a focused field's text is smaller than 16 px.
// Font size and the boxes around a field are layout results, which happy-dom
// does not model, so a real engine renders the shipped stylesheet.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-touch-field-text-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { ChatComposer } = await import("../chat/ChatComposer");
const { AutocompleteEditor } = await import("../inputs/AutocompleteEditor");
const { AutocompleteSelect } = await import("../inputs/AutocompleteSelect");
const { PinInput } = await import("../inputs/ChoiceInputs");
const { Combobox } = await import("../inputs/Combobox");
const { MarkdownEditor } = await import("../inputs/markdown/MarkdownEditor");
const { NumberInput } = await import("../inputs/NumberInput");
const { TagsInput } = await import("../inputs/TagsInput");
const { TextInput } = await import("../inputs/TextInput");

const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
const touchQuery = "@media (pointer:coarse)";
// The same phone with the touch rules switched off: what it rendered before them.
const cssWithoutTouchRules = css.replaceAll(touchQuery, "@media not all");
const phone = { viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const noop = () => {};
const rendered: [string, () => JSX.Element][] = [
  [
    "text",
    () => createComponent(TextInput, { label: "Project", description: "Shown on the overview.", value: "Atlas", icon: "ti ti-folder" }),
  ],
  ["password", () => createComponent(TextInput, { label: "Password", value: "secret", password: true })],
  ["textarea", () => createComponent(TextInput, { label: "Notes", value: "First line\nSecond line", multiline: true, lines: 3 })],
  ["monospace", () => createComponent(TextInput, { label: "Token", value: "a1b2c3", monospace: true })],
  ["number", () => createComponent(NumberInput, { label: "Budget", value: 1200, prefix: "€", suffix: "gross", onValueChange: noop })],
  ["combobox", () => createComponent(Combobox, { label: "City", query: "Par", fetchData: async () => [], onSelect: noop })],
  [
    "autocomplete select",
    () =>
      createComponent(AutocompleteSelect, { label: "Category", value: null, search: async () => ({ options: [] }), onValueChange: noop }),
  ],
  ["tags", () => createComponent(TagsInput, { label: "Tags", value: ["alpha", "beta"], onValueChange: noop })],
  ["pin", () => createComponent(PinInput, { label: "Code", value: "12", length: 6, onValueChange: noop })],
  [
    "autocomplete editor",
    () => createComponent(AutocompleteEditor, { label: "Message", value: "Hello @de", lines: 3, onValueChange: noop }),
  ],
  ["markdown editor", () => createComponent(MarkdownEditor, { label: "Release note", value: "# Title\n\nSome **bold** text.", lines: 4 })],
  ["chat composer", () => createComponent(ChatComposer, { value: "", onValueChange: noop, onSubmit: noop })],
];
// These fields exist only inside an opened popover, dialog, or edit mode, so
// the page carries the markup their components render there.
const opened: [string, string][] = [
  ["select search", `<div class="k2b-choice-search"><i class="ti ti-search"></i><input type="search" placeholder="Search"></div>`],
  [
    "time",
    `<label class="k2b-date-time"><span>Time</span><span class="k2b-date-time__control"><input type="text" inputmode="numeric" value="09:00"><i class="ti ti-clock"></i></span></label>`,
  ],
  [
    "search prompt",
    `<div class="k2b-prompt-search"><label class="k2b-prompt-search__input"><i class="ti ti-search"></i><input type="search" placeholder="Search"></label></div>`,
  ],
  [
    "slash list search",
    `<label class="k2b-chat-composer__command-search"><i class="ti ti-search"></i><input type="text" role="combobox" placeholder="Search"></label>`,
  ],
  ["file rename", `<input class="k2b-content-file-tree__rename" value="report.pdf">`],
  [
    "source file",
    `<div class="k2b-markdown-editor__surface" style="position:relative;height:8rem"><textarea class="k2b-content-file-view__code-input">const a = 1;</textarea></div>`,
  ],
];
const fields = [...rendered.map(([name, view]): [string, string] => [name, renderToString(view)]), ...opened];
// @k2b/ui sets no line height of its own. Cloud inherits 1.5 from Tailwind's
// base styles; a plain host leaves `normal`, which browsers derive from
// rounded font metrics.
const hosts = { tailwind: "line-height:1.5", plain: "" };
type Host = keyof typeof hosts;
// The search prompt row has no height of its own and takes it from the field's
// line box. `lh` restores that height exactly for a numeric line height; with
// `normal` the rounded metrics leave a fraction of a pixel.
const fieldsIn = (host: Host) => fields.filter(([name]) => host === "tailwind" || name !== "search prompt");
const page = (styles: string, host: Host) =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style>` +
  `<style>solid-client,solid-island{display:contents}</style></head>` +
  `<body class="k2b-ui" style="${hosts[host]}"><main style="padding:1rem">${fieldsIn(host)
    .map(([name, markup]) => `<section data-field="${name}">${markup}<p>After ${name}</p></section>`)
    .join("")}</main></body></html>`;

const editable =
  "input:not([type=hidden], [type=checkbox], [type=radio], [type=range], [type=file], [type=color]), textarea, select, [contenteditable]:not([contenteditable=false])";

/** Every element's box and every editable field's text metrics, with each field focused in turn. */
const measure = async (styles: string, host: Host) => {
  const tab = await browser.newPage(phone);
  try {
    await tab.setContent(page(styles, host));
    await settled(tab);
    return await tab.evaluate((selector) => {
      const boxes = () =>
        Array.from(document.querySelectorAll("main *")).map((element, index) => {
          const box = element.getBoundingClientRect();
          const name = `${index} ${element.tagName.toLowerCase()}.${element.getAttribute("class") ?? ""}`;
          return `${name} ${[box.x, box.y, box.width, box.height].map((value) => Math.round(value * 100) / 100).join(" ")}`;
        });
      const text: Record<string, { fontSize: number; lineHeight: string }[]> = {};
      const focused: Record<string, string[]> = {};
      for (const section of Array.from(document.querySelectorAll<HTMLElement>("[data-field]"))) {
        const name = section.dataset.field!;
        const inputs = Array.from(section.querySelectorAll<HTMLElement>(selector));
        text[name] = inputs.map((input) => {
          const style = getComputedStyle(input);
          return { fontSize: Number.parseFloat(style.fontSize), lineHeight: style.lineHeight };
        });
        // Some fields swap their presentation for the editor on focus.
        inputs[0]?.focus();
        focused[name] = boxes();
      }
      (document.activeElement as HTMLElement | null)?.blur();
      return { text, focused, idle: boxes(), pageHeight: document.documentElement.scrollHeight };
    }, editable);
  } finally {
    await tab.close();
  }
};

describe("@k2b/ui field text on a phone", () => {
  test("is at least 16 px in every editable field, so iOS Safari does not zoom on focus", async () => {
    const { text } = await measure(css, "tailwind");
    for (const [name] of fields) {
      expect(text[name]?.length, name).toBeGreaterThan(0);
      for (const field of text[name]!) expect(field.fontSize, name).toBeGreaterThanOrEqual(16);
    }
  }, 30_000);

  test.each(Object.keys(hosts) as Host[])(
    "keeps every box of the field, its label, and its neighbours where it was in a %s host",
    async (host) => {
      expect(css).toContain(touchQuery);
      const before = await measure(cssWithoutTouchRules, host);
      const after = await measure(css, host);
      // Guards the comparison itself: without the touch rules the text is small again.
      expect(before.text.text![0]!.fontSize).toBe(14);
      expect(after.idle).toEqual(before.idle);
      expect(after.focused).toEqual(before.focused);
      expect(after.pageHeight).toBe(before.pageHeight);
    },
    30_000,
  );
});

test.each([false, true])(
  "compact values keep their 26 px shell and readable text (touch=%s)",
  async (touch) => {
    const tab = await browser.newPage({ viewport: { width: 390, height: 664 }, isMobile: touch, hasTouch: touch });
    try {
      const markup = renderToString(() =>
        createComponent(TextInput, {
          variant: "compact",
          value: "Europe",
          prefix: ":region",
          "aria-label": "Region",
          monospace: true,
        }),
      );
      await tab.setContent(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="k2b-ui">${markup}</body></html>`,
      );
      const input = tab.getByRole("textbox", { name: "Region", exact: true });
      const measureCompact = () =>
        input.evaluate((element) => {
          const shell = element.parentElement!;
          const box = element.getBoundingClientRect();
          return {
            shellHeight: shell.getBoundingClientRect().height,
            inputHeight: box.height,
            fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
            lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
            iconCount: shell.querySelectorAll(".k2b-input-shell__icon").length,
          };
        });
      await settled(tab);
      const before = await measureCompact();
      expect(before.shellHeight).toBe(26);
      expect(before.inputHeight).toBe(20);
      expect(before.lineHeight).toBe(20);
      expect(before.fontSize).toBe(touch ? 16 : 12);
      expect(before.iconCount).toBe(0);
      await input.focus();
      await settled(tab);
      expect(await measureCompact()).toEqual(before);
      expect(await input.inputValue()).toBe("Europe");
    } finally {
      await tab.close();
    }
  },
  30_000,
);

test("embedded code keeps its overlay and gutter aligned at the touch font size", async () => {
  const tab = await browser.newPage(phone);
  try {
    const markup = renderToString(() =>
      createComponent(AutocompleteEditor, {
        variant: "embedded",
        fill: true,
        lineNumbers: true,
        markedLine: 2,
        value: "SELECT region\nFROM events",
        "aria-label": "Query",
        highlight: (text) => text,
      }),
    );
    await tab.setContent(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="k2b-ui"><div style="height:232px;font-size:13px;line-height:20px">${markup}</div></body></html>`,
    );
    await settled(tab);
    const metrics = await tab.locator('[data-variant="embedded"]').evaluate((element) => {
      const measureLayer = (selector: string) => {
        const node = element.querySelector<HTMLElement>(selector)!;
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        return { font: Number.parseFloat(style.fontSize), line: Number.parseFloat(style.lineHeight), height: box.height };
      };
      return {
        input: measureLayer(".k2b-autocomplete__input"),
        overlay: measureLayer(".k2b-autocomplete__preview"),
        gutter: measureLayer(".k2b-autocomplete__gutter"),
        height: element.getBoundingClientRect().height,
      };
    });
    expect(metrics.height).toBe(232);
    expect(metrics.input.font).toBeGreaterThanOrEqual(16);
    expect(metrics.input).toEqual(metrics.overlay);
    expect(metrics.gutter.font).toBe(metrics.input.font);
    expect(metrics.gutter.line).toBe(metrics.input.line);
    expect(metrics.input.line).toBe(20);
  } finally {
    await tab.close();
  }
}, 30_000);

test.each([false, true])(
  "compact errors stay visible inline or at an explicit external target (touch=%s)",
  async (touch) => {
    const tab = await browser.newPage({ viewport: { width: 390, height: 664 }, isMobile: touch, hasTouch: touch });
    try {
      const inline = renderToString(() =>
        createComponent(TextInput, {
          id: "inline-region",
          value: "",
          variant: "compact",
          "aria-label": "Inline region",
          error: "Enter a region.",
        }),
      );
      const external = renderToString(() =>
        createComponent(TextInput, {
          id: "external-region",
          value: "",
          variant: "compact",
          "aria-label": "External region",
          error: "Choose a known region.",
          externalErrorId: "123:problem",
        }),
      );
      await tab.setContent(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body class="k2b-ui">${inline}${external}<p id="123:problem" role="status">Choose a known region.</p></body></html>`,
      );
      const inlineInput = tab.getByRole("textbox", { name: "Inline region", exact: true });
      const externalInput = tab.getByRole("textbox", { name: "External region", exact: true });
      expect(await tab.locator(".k2b-field__error").count()).toBe(1);
      expect(await tab.locator(".k2b-field__error").isVisible()).toBeTrue();
      expect(await inlineInput.getAttribute("aria-describedby")).toBe("inline-region-error");
      expect(await externalInput.getAttribute("aria-describedby")).toBe("123:problem");
      expect(await tab.getByRole("status").isVisible()).toBeTrue();
      for (const input of [inlineInput, externalInput]) {
        expect(await input.getAttribute("aria-invalid")).toBe("true");
        await settled(tab);
        expect(await input.evaluate((element) => element.parentElement!.getBoundingClientRect().height)).toBe(26);
        expect(await input.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBe(touch ? 16 : 12);
        const before = await input.evaluate((element) => element.parentElement!.getBoundingClientRect().toJSON());
        await input.focus();
        await settled(tab);
        expect(await input.evaluate((element) => element.parentElement!.getBoundingClientRect().toJSON())).toEqual(before);
      }
    } finally {
      await tab.close();
    }
  },
  30_000,
);

// Keep the first SSR DOM: the existing static style cases and happy-dom runtime
// tests cannot establish that hydration reuses a field or its generated error ID.
test("native external errors retain their SSR nodes, IDs, focus and selection through first hydration", async () => {
  const ui = resolve(import.meta.dir, "../..");
  const fixturePath = resolve(import.meta.dir, "text-error-hydration.fixture.tsx");
  const fixture = (entry: string) => `
import { createSignal, createUniqueId } from "solid-js";
import { TextInput } from ${JSON.stringify(entry)};
function ErrorField(props: { multiline: boolean }) {
  const id = createUniqueId();
  const [error, setError] = createSignal<string | undefined>("Enter a region.");
  const [target, setTarget] = createSignal<string | undefined>("123:" + id);
  let ref: HTMLInputElement | undefined;
  return <section data-mode={props.multiline ? "textarea" : "input"}>
    <TextInput variant="compact" label="Region" description="Choose a known region."
      value="Europe" multiline={props.multiline} error={error} externalErrorId={target()}
      ref={(node) => { ref = node; node.dataset.refBound = "true"; }} />
    <p id={target()} hidden={!target() || !error()} role="status">{error()}</p>
    <button data-action="other" onClick={() => { setTarget("456:" + id); setError("Use a known region."); }}>Other error</button>
    <button data-action="inline" onClick={() => setTarget(undefined)}>Inline error</button>
    <button data-action="correct" onClick={() => setError(undefined)}>Correct</button>
    <button data-action="check-ref" onClick={() => { if (ref) ref.dataset.refChecked = "true"; }}>Check ref</button>
  </section>;
}
export function Fixture() { return <><ErrorField multiline={false} /><ErrorField multiline={true} /></>; }
`;
  const bundle = async (server: boolean) => {
    const entry = resolve(import.meta.dir, server ? "text-error-hydration.server.ts" : "text-error-hydration.client.ts");
    const build = await Bun.build({
      entrypoints: [entry],
      files: {
        [entry]: server
          ? `
import { createComponent } from "solid-js";
import { renderToString, generateHydrationScript } from "solid-js/web";
import { Fixture } from "./text-error-hydration.fixture";
export const markup = renderToString(() => createComponent(Fixture, {}));
export const hydrationScript = generateHydrationScript();
`
          : `
import { createComponent } from "solid-js";
import { hydrate } from "solid-js/web";
import { Fixture } from "./text-error-hydration.fixture";
hydrate(() => createComponent(Fixture, {}), document.getElementById("app"));
document.body.dataset.hydrated = "true";
`,
      },
      target: server ? "node" : "browser",
      format: server ? "esm" : "iife",
      conditions: server ? ["node"] : ["browser"],
      plugins: [
        {
          name: "text-error-hydration",
          setup(builder) {
            builder.onResolve({ filter: /text-error-hydration\.fixture$/ }, () => ({ path: fixturePath, namespace: "error-fixture" }));
            builder.onLoad({ filter: /\.tsx$/, namespace: "error-fixture" }, async ({ path }) => {
              const result = await transformAsync(fixture(resolve(ui, server ? "src/inputs/TextInput.tsx" : "dist/browser/index.js")), {
                filename: path,
                babelrc: false,
                configFile: false,
                presets: [typescript, [solid, { generate: server ? "ssr" : "dom", hydratable: true }]],
              });
              if (!result?.code) throw new Error("Could not compile error hydration fixture");
              return { contents: result.code, loader: "js", resolveDir: import.meta.dir };
            });
            if (server)
              builder.onLoad({ filter: /\.tsx$/, namespace: "file" }, async ({ path }) => {
                const result = await transformAsync(await Bun.file(path).text(), {
                  filename: path,
                  babelrc: false,
                  configFile: false,
                  presets: [typescript, [solid, { generate: "ssr", hydratable: true }]],
                });
                if (!result?.code) throw new Error(`Could not compile ${path}`);
                return { contents: result.code, loader: "js" };
              });
          },
        },
      ],
    });
    if (!build.success) throw new AggregateError(build.logs, "Could not bundle error hydration fixture");
    return build.outputs[0]!.text();
  };
  const serverPath = resolve(root, "text-error-hydration.mjs");
  writeFileSync(serverPath, await bundle(true));
  const { markup, hydrationScript }: { markup: string; hydrationScript: string } = await import(serverPath);
  const script = await bundle(false);
  const tab = await browser.newPage(phone);
  const errors = pageErrors(tab);
  tab.on("console", (message) => {
    if ((message.type() === "warning" || message.type() === "error") && /hydrat/i.test(message.text())) errors.push(message.text());
  });
  try {
    await tab.setContent(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body class="k2b-ui"><main id="app">${markup}</main>${hydrationScript}</body></html>`,
    );
    const controls = tab.locator("input,textarea");
    expect(await controls.count()).toBe(2);
    expect(await controls.first().inputValue()).toBe("Europe");
    expect(await controls.last().inputValue()).toBe("Europe");
    await settled(tab);
    const before = await controls.evaluateAll((elements) =>
      elements.map((element) => {
        element.setAttribute("data-ssr-node", "preserved");
        return { id: element.id, describedBy: element.getAttribute("aria-describedby"), box: element.getBoundingClientRect().toJSON() };
      }),
    );
    for (const section of [tab.locator('[data-mode="input"]'), tab.locator('[data-mode="textarea"]')]) {
      const input = section.locator("input,textarea");
      const target = (await input.getAttribute("aria-describedby"))!.split(" ").at(-1)!;
      expect(await tab.locator(`[id="${target}"]`).innerText()).toBe("Enter a region.");
      expect(await tab.locator(`[id="${target}"]`).isVisible()).toBeTrue();
    }
    expect(await tab.locator(".k2b-field__error").count()).toBe(0);
    await controls.last().focus();
    await controls.last().evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(1, 4));
    expect(await controls.last().evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([
      1, 4,
    ]);
    await tab.addScriptTag({ content: script });
    await tab.waitForSelector('body[data-hydrated="true"]');
    expect(errors).toEqual([]);
    await settled(tab);
    const after = await controls.evaluateAll((elements) =>
      elements.map((element) => ({
        id: element.id,
        describedBy: element.getAttribute("aria-describedby"),
        box: element.getBoundingClientRect().toJSON(),
      })),
    );
    expect(after).toEqual(before);
    expect(
      await controls.evaluateAll((elements) =>
        elements.every(
          (element) => element.getAttribute("data-ssr-node") === "preserved" && element.getAttribute("data-ref-bound") === "true",
        ),
      ),
    ).toBeTrue();
    expect(
      await controls
        .last()
        .evaluate((element: HTMLTextAreaElement) => [element === document.activeElement, element.selectionStart, element.selectionEnd]),
    ).toEqual([true, 1, 4]);
    for (const mode of ["input", "textarea"]) {
      const section = tab.locator(`[data-mode="${mode}"]`);
      const input = section.locator("input,textarea");
      await input.focus();
      await input.evaluate((element: HTMLInputElement | HTMLTextAreaElement) => element.setSelectionRange(1, 4));
      for (const action of ["other", "inline", "correct"]) {
        await section.locator(`[data-action="${action}"]`).dispatchEvent("click");
        expect(await input.getAttribute("data-ssr-node")).toBe("preserved");
        expect(await input.inputValue()).toBe("Europe");
        expect(
          await input.evaluate((element: HTMLInputElement | HTMLTextAreaElement) => [
            element === document.activeElement,
            element.selectionStart,
            element.selectionEnd,
          ]),
        ).toEqual([true, 1, 4]);
        const describedBy = (await input.getAttribute("aria-describedby"))!.split(" ");
        if (action === "other") {
          expect(describedBy.at(-1)).toMatch(/^456:/);
          expect(await section.getByRole("status").innerText()).toBe("Use a known region.");
          expect(await section.getByRole("status").isVisible()).toBeTrue();
          expect(await section.locator(".k2b-field__error").count()).toBe(0);
        } else if (action === "inline") {
          expect(describedBy.at(-1)).toBe(`${await input.getAttribute("id")}-error`);
          expect(await section.locator(".k2b-field__error").innerText()).toBe("Use a known region.");
          expect(await section.locator(".k2b-field__error").isVisible()).toBeTrue();
        } else {
          expect(describedBy).toHaveLength(1);
          expect(await input.getAttribute("aria-invalid")).toBeNull();
          expect(await section.locator(".k2b-field__error").count()).toBe(0);
        }
      }
      await section.locator('[data-action="check-ref"]').dispatchEvent("click");
      expect(await input.getAttribute("data-ref-checked")).toBe("true");
    }
    expect(errors).toEqual([]);
  } finally {
    await tab.close();
  }
}, 60_000);

import { afterAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import expected from "./field-markup.expected.json" with { type: "json" };

/**
 * Fields without a `suggestion` must render exactly the server markup they rendered before field suggestions
 * existed: no extra node, attribute, or hydration marker. The cases compile as an island does (Solid's hydratable
 * server output), so markers count. The expectation was frozen from origin/main before field suggestions
 * (7126f02737); change it only together with a deliberate change of a field's markup.
 */
const cases = `
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { DatePicker, NumberInput, Select, Slider, Switch, TextInput } from "../index";
const options = [
  { value: "3400", label: "3400 Goods received" },
  { value: "3300", label: "3300 Goods received, reduced rate" },
];
const cases = {
  "text with label": () => createComponent(TextInput, { id: "number", label: "Invoice number", name: "number", placeholder: "INV-…", value: "" }),
  "text search without label": () => createComponent(TextInput, { id: "search", "aria-label": "Search help", type: "search", icon: "ti ti-search", placeholder: "Search help", clearable: true, value: "invoice" }),
  "text multiline": () => createComponent(TextInput, { id: "text", label: "Booking text", multiline: true, lines: 2, value: "Purchase" }),
  "text required with description and error": () => createComponent(TextInput, { id: "mail", label: "Mail", description: "Where the receipt goes.", error: "Enter an address.", required: true, type: "email", value: "" }),
  number: () => createComponent(NumberInput, { id: "gross", label: "Gross amount", step: 0.01, suffix: "€", value: 321.4 }),
  "number plain": () => createComponent(NumberInput, { id: "minutes", "aria-label": "Minutes", appearance: "plain", value: null }),
  date: () => createComponent(DatePicker, { id: "date", label: "Invoice date", value: "2026-10-28", dateConfig: { locale: "en" } }),
  "date plain": () => createComponent(DatePicker, { id: "due", label: "Due", appearance: "plain", value: null, dateConfig: { locale: "en" } }),
  select: () => createComponent(Select, { id: "account", label: "Account", placeholder: "Choose…", value: null, options }),
  "select without label": () => createComponent(Select, { id: "account2", "aria-label": "Account", value: "3400", options }),
  switch: () => createComponent(Switch, { id: "deduct", label: "Deduct input VAT", description: "Only for business purchases.", value: true }),
  "switch without label": () => createComponent(Switch, { id: "deduct2", "aria-label": "Deduct input VAT", value: false }),
  "slider with label end": () => createComponent(Slider, { id: "contrast", label: "Contrast", value: 20, defaultValue: 0, valuePlacement: "label" }),
};
export const render = () => Object.fromEntries(Object.entries(cases).map(([name, view]) => [name, renderToString(view)]));
`;

const fixture = await (async () => {
  const { transformAsync } = await import("@babel/core");
  const typescript = (await import("@babel/preset-typescript")).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", import.meta.dir))).default;
  const directory = mkdtempSync(join(tmpdir(), "k2b-ui-field-markup-"));
  const entry = resolve(import.meta.dir, "field-markup.ssr-fixture.ts");
  const build = await Bun.build({
    entrypoints: [entry],
    files: { [entry]: cases },
    target: "bun",
    conditions: ["node"],
    plugins: [
      {
        name: "field-markup-ssr",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
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
  try {
    if (!build.success) throw new AggregateError(build.logs, "Could not compile the field markup fixture");
    const path = join(directory, "server.mjs");
    await Bun.write(path, build.outputs[0]!);
    const module: { render?: unknown } = await import(path);
    const render = module.render;
    if (typeof render !== "function") throw new Error("The field markup fixture exports no render()");
    return {
      directory,
      render: (): Record<string, string> =>
        Object.fromEntries(Object.entries(Object(render())).map(([name, html]) => [name, String(html)])),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
})();
afterAll(() => rmSync(fixture.directory, { recursive: true, force: true }));

describe("@k2b/ui fields without a suggestion", () => {
  test("render the same server markup as before field suggestions, byte for byte, hydration markers included", () => {
    // The date field's status line names its day relative to today ("Wednesday, 11 days ago"), so the clock stands
    // on the day the expectation was recorded; otherwise the frozen markup goes stale at every midnight.
    setSystemTime(new Date("2026-11-08T12:00:00Z"));
    let rendered: Record<string, string>;
    try {
      rendered = fixture.render();
    } finally {
      setSystemTime();
    }
    expect(Object.keys(rendered)).toEqual(Object.keys(expected));
    for (const [name, html] of Object.entries(rendered)) expect(html, name).toBe(expected[name as keyof typeof expected]);
  });
});

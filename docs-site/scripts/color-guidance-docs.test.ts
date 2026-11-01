import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { appColors } from "@k2b/cloud/ssr/app-color.ts";
import { type CssRule, cssDeclarations, parseCssRules } from "../../packages/ui/src/styles/css-contract-test-helpers";
import { colorDemoHosts } from "../src/ui/demo-sections/color-hosts";

const ui = resolve(import.meta.dir, "../../packages/ui/src");
const styles = resolve(ui, "styles");
const page = resolve(import.meta.dir, "../src/ui/context/surfaces/color.md");
const rules = readdirSync(styles)
  .filter((file) => file.endsWith(".css"))
  .flatMap((file) => parseCssRules(file, readFileSync(resolve(styles, file), "utf8")));
const block = (rule: CssRule) =>
  [...rule.selector.matchAll(/\.(k2b-[\w-]+(?:__[\w-]+)?)/g)].find((match) => match[1] !== "k2b-ui")?.[1]?.split("__")[0];
const blocks = (matches: CssRule[]) => new Set(matches.map(block).filter((name) => name !== undefined));
const values = (rule: CssRule) => [...cssDeclarations(rule.body).values()].flat();
const consumes = (hook: string) => rules.filter((rule) => values(rule).some((value) => value.includes(`var(${hook})`)));
const nav = blocks(consumes("--k2b-app-workspace-selected"));
const row = blocks(consumes("--k2b-row-selected"));
// A dropdown menu control is not a drag-and-drop target.
const isDropTarget = (rule: CssRule) => /drop(?!down)/.test(rule.selector);
const control = blocks(
  rules.filter((rule) => {
    if (isDropTarget(rule)) return false;
    const background = ["background", "background-color"].flatMap((property) => cssDeclarations(rule.body).get(property) ?? []);
    const selected = /:checked|\[(?:aria-(?:pressed|selected|checked|current)|data-selected)=["']true["']\]|\.is-current\b/.test(
      rule.selector,
    );
    return (
      background.some((value) => ["var(--k2b-selected)", "var(--k2b-action-solid)", "var(--k2b-action)"].includes(value)) &&
      (selected || rule.selector === ".k2b-ui .k2b-button")
    );
  }),
);
const dropPaint = (rule: CssRule) =>
  ["background", "background-color", "box-shadow", "border-color"]
    .flatMap((property) => cssDeclarations(rule.body).get(property) ?? [])
    .some((value) => /var\(--k2b-(?:selected|action-solid|action)\s*[,)]/.test(value));
const drop = blocks(rules.filter((rule) => isDropTarget(rule) && dropPaint(rule)));
const sorted = (names: Iterable<string>) => [...new Set(names)].sort();

// Public @k2b/ui names from category indexes and declared optional entry points.
const definedIn = new Map<string, string>();
const publicEntries = Object.keys(JSON.parse(readFileSync(resolve(ui, "../package.json"), "utf8")).exports);
for (const folder of readdirSync(ui, { withFileTypes: true })) {
  if (!folder.isDirectory()) continue;
  const index = existsSync(resolve(ui, folder.name, "index.ts"))
    ? resolve(ui, folder.name, "index.ts")
    : publicEntries.includes(`./${folder.name}`)
      ? resolve(ui, `${folder.name}.ts`)
      : undefined;
  if (!index || !existsSync(index)) continue;
  for (const [, names] of readFileSync(index, "utf8").matchAll(/export\s*\{([^}]+)\}/g))
    for (const item of names!.split(",").map((part) => part.trim()))
      if (item && !item.startsWith("type ")) definedIn.set(item.split(/\s+as\s+/).at(-1)!, folder.name);
}
const isPublic = (name: string) => definedIn.has(name);

const readPage = () => {
  expect(existsSync(page), "The canonical color guide must exist").toBe(true);
  return readFileSync(page, "utf8");
};
const table = (source: string, heading: string) => {
  const lines = source.split(/\r?\n/);
  const start = lines.indexOf(heading);
  expect(start, `Missing color guide heading: ${heading}`).toBeGreaterThanOrEqual(0);
  const level = heading.match(/^#+/)![0].length;
  const end = lines.findIndex((line, index) => index > start && (line.match(/^(#+) /)?.[1]?.length ?? Infinity) <= level);
  const section = lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
  // The controls table is directly under its heading, before any subsections.
  const content = heading === "## Controls stay platform blue" ? section.split(/^#+ /m)[0]! : section;
  const rows = content
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1));
  expect(rows.length, `${heading} must contain a Markdown table`).toBeGreaterThan(2);
  const classes = new Set(rows.flatMap((cells) => [...cells.at(-1)!.matchAll(/`(k2b-[\w-]+)`/g)].map((match) => match[1]!)));
  const primitives = new Set(rows.flatMap((cells) => [...cells[1]!.matchAll(/`([A-Z]\w*)(?:\.[^`]*)?`/g)].map((match) => match[1]!)));
  return { classes, primitives };
};

describe("color guide agrees with the shared CSS", () => {
  test("editor size choices and the checked header switch are controls, not drop targets", () => {
    expect(control.has("k2b-ste-size-row")).toBe(true);
    expect(control.has("k2b-ste-header-choice")).toBe(true);
    expect(drop.has("k2b-ste-size-row")).toBe(false);
    expect(drop.has("k2b-ste-header-choice")).toBe(false);
    expect(drop.has("k2b-drop-target")).toBe(true);
    expect(definedIn.get("TextEditor")).toBe("text-editor");
    expect(definedIn.get("TableSizePicker")).toBe("text-editor");
  });

  test("navigation and selection-control tables split the navigation fill consumers", () => {
    const source = readPage();
    const navigation = table(source, "### Navigation fill");
    const tabs = table(source, "### Selected tabs, segments, and filters");
    expect(sorted([...navigation.classes, ...tabs.classes]), "The two tables must cover every navigation fill consumer").toEqual(
      sorted(nav),
    );
    expect(
      [...navigation.classes].filter((name) => tabs.classes.has(name)),
      "Navigation and selection-control tables must be disjoint",
    ).toEqual([]);
    // Navigation lives in layout/, tabs, segments, and filter chips in actions/.
    for (const name of navigation.primitives) expect(definedIn.get(name), `${name} is navigation`).toBe("layout");
    for (const name of tabs.primitives) expect(definedIn.get(name), `${name} is a selection control`).toBe("actions");
  });

  for (const [heading, expected] of [
    ["### Row fill", row],
    ["## Controls stay platform blue", control],
    ["### Drop targets", drop],
  ] as const) {
    test(`${heading}: table covers exactly the CSS consumers`, () => {
      expect(sorted(table(readPage(), heading).classes), `${heading}: documented classes must match CSS blocks exactly`).toEqual(
        sorted(expected),
      );
    });
  }

  test("navigation insertion lines do not consume platform drop paint", () => {
    const insertion = rules.filter((rule) => rule.selector.includes(".k2b-app-workspace__nav-tree-node[data-k2b-nav-tree-drop"));
    expect(insertion.length, "The navigation insertion-line rules must be inspected").toBeGreaterThan(0);
    expect(insertion.some(dropPaint), "Navigation insertion lines must not consume platform drop paint").toBe(false);
  });

  test("all table primitives name public UI exports", () => {
    const source = readPage();
    for (const heading of [
      "### Navigation fill",
      "### Selected tabs, segments, and filters",
      "### Row fill",
      "## Controls stay platform blue",
      "### Drop targets",
    ]) {
      for (const name of table(source, heading).primitives)
        expect(isPublic(name), `${heading}: ${name} must be publicly exported by @k2b/ui`).toBe(true);
    }
  });

  test("hook names and defaults match the scope, without a Cloud package dependency in the page", () => {
    const source = readPage();
    const scope = cssDeclarations(
      rules
        .filter((rule) => rule.file === "index.css" && rule.selector === ".k2b-ui" && !rule.context)
        .map((rule) => rule.body)
        .join(";"),
    );
    for (const hook of [
      "--k2b-app-workspace-selected",
      "--k2b-app-workspace-active",
      "--k2b-row-selected",
      "--k2b-link-accent",
      "--k2b-focus-ring",
    ]) {
      expect(source, `The color guide must name ${hook}`).toContain(`\`${hook}\``);
    }
    const bullets = source.split(/\n(?=- |\n)/).filter((text) => text.startsWith("- "));
    for (const hook of ["--k2b-app-workspace-selected", "--k2b-app-workspace-active", "--k2b-row-selected"]) {
      const defaults = scope.get(hook);
      expect(defaults?.length, `${hook} must have one CSS scope default`).toBe(1);
      const bullet = bullets.find((text) => text.startsWith(`- \`${hook}\``))?.replace(/\s+/g, " ");
      expect(bullet, `${hook}'s own bullet must state its CSS default`).toContain(`defaults to \`${defaults![0]}\``);
    }
    expect(source, "The portable UI page must not depend on the Cloud package").not.toContain("@k2b/cloud");
  });

  test("demo host ink and selection fills equal Cloud's derivation in both themes", () => {
    for (const host of colorDemoHosts) {
      const derived = appColors(host.accent);
      for (const theme of ["light", "dark"] as const) {
        const { ink, selected, selectedNav } = derived[theme];
        expect(host[theme], `${host.label} ${theme}: demo must use derived app colors`).toEqual({ ink, selected, selectedNav });
      }
    }
  });
});

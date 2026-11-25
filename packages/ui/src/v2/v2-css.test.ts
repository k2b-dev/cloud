import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss, { type Rule } from "postcss";
import selectorParser from "postcss-selector-parser";
import { heights, radii, textEdge, typeRoles } from "./tokens";

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const root = postcss.parse(css);

/** The declarations of the rule whose selector is exactly `selector`, outside any at-rule unless `media` names one. */
const declarations = (selector: string, media?: string): Map<string, string> => {
  const found = new Map<string, string>();
  root.walkRules((rule) => {
    const parent = rule.parent?.type === "atrule" ? (rule.parent as postcss.AtRule).params : undefined;
    if (rule.selector !== selector || parent !== media) return;
    rule.walkDecls((declaration) => {
      found.set(declaration.prop, declaration.value);
    });
  });
  return found;
};

const scope = declarations(".k2-ui");
const phone = declarations(".k2-ui", "not all and (min-width: 768px)");

test("the type roles in v2.css are the roles in tokens.ts", () => {
  for (const [role, { size, lineHeight, weight }] of Object.entries(typeRoles))
    expect(scope.get(`--k2-t-${role}`)).toBe(`${weight} ${size}px/${lineHeight}px var(--k2-font)`);
});

test("the phone is one query, `not all and (min-width: 768px)`, so a fractional width at zoom has no gap", () => {
  // `max-width: 767px` leaves 767.5 px between the phone and the wide screen: rules of both sides would miss it
  const media: string[] = [];
  root.walkAtRules("media", (rule) => {
    media.push(rule.params);
  });
  expect(media.filter((params) => /width/.test(params))).toEqual(media.filter((params) => params === "not all and (min-width: 768px)"));
  expect(media.filter((params) => /max-width/.test(params))).toEqual([]);
});

test("the text edge is 20 px, 16 px below 768 px, and 24 px further in after an icon", () => {
  expect(scope.get("--k2-edge")).toBe(`${textEdge.wide}px`);
  expect(phone.get("--k2-edge")).toBe(`${textEdge.phone}px`);
  expect(scope.get("--k2-edge-icon")).toBe(`calc(var(--k2-edge) + ${textEdge.afterIcon}px)`);
  expect(phone.size).toBe(1);
});

test("there is one hairline of 1 px, and the radii and heights are the tokens", () => {
  expect(scope.get("--k2-hairline")).toBe("1px solid var(--k2-line)");
  expect(scope.get("--k2-r-mark")).toBe(`${radii.mark}px`);
  expect(scope.get("--k2-r-control")).toBe(`${radii.control}px`);
  expect(scope.get("--k2-r-overlay")).toBe(`${radii.overlay}px`);
  expect(scope.get("--k2-r-round")).toBe(`${radii.round}px`);
  expect(scope.get("--k2-r-card")).toBe(`${radii.card}px`);
  const names: Record<keyof typeof heights, string> = {
    head: "head",
    status: "status",
    tabs: "tabs",
    bar: "bar",
    columns: "columns",
    row: "row",
    row2: "row2",
    row3: "row3",
    dense: "dense",
    control: "control",
    controlSmall: "control-small",
  };
  for (const [key, name] of Object.entries(names)) expect(scope.get(`--k2-h-${name}`)).toBe(`${heights[key as keyof typeof heights]}px`);
});

test("dark mode redefines only colours and shadows, never a measure", () => {
  const dark = declarations(
    '.dark .k2-ui:not([data-theme="light"], [data-theme="light"] .k2-ui),\n.k2-ui.dark,\n.k2-ui[data-theme="dark"]',
  );
  expect(dark.size).toBeGreaterThan(20);
  for (const [property, value] of dark) {
    expect(property.startsWith("--k2-")).toBe(true);
    // a literal colour or shadow, or one mixed from the app's accent
    expect(/^(?:#[0-9a-f]{6}|rgb\(|0 |color-mix\()/.test(value)).toBe(true);
  }
  // Every colour the dark theme sets exists in light first.
  for (const property of dark.keys()) expect(scope.has(property)).toBe(true);
});

type SelectorNode = selectorParser.Node;

/**
 * What keeps one selector out of v2's namespace: it must stand below `.k2-ui`, its classes are `k2-` classes, and a
 * tag or `*` only stands inside a primitive (`.k2-table th`, `.k2-prose :where(ul)`), never alone below the root, where
 * it would restyle markup that is not v2's. A sibling (`+`, `~`) of a primitive stands beside it, not inside it; it is
 * inside only what holds both (`.k2-sh > .k2-stile + h3`). The arguments of a pseudo-class are selectors of their own:
 * they start where the pseudo-class stands and leak nothing after it.
 */
const namespaceProblems = (selectorText: string): string[] => {
  const problems: string[] = [];
  const check = (nodes: readonly SelectorNode[], start: boolean): { scoped: boolean } => {
    // `inside`: an ancestor compound is a primitive; `here`: the current compound is one
    let inside = start;
    let here = false;
    let scoped = false;
    for (const node of nodes) {
      if (node.type === "combinator") {
        if (node.value === "+" || node.value === "~") here = false;
        else {
          inside ||= here;
          here = false;
        }
      }
      if (node.type === "class") {
        if (node.value === "k2-ui") scoped = true;
        else if (node.value.startsWith("k2-")) here = true;
        else if (node.value !== "dark") problems.push(`class .${node.value} in ${selectorText}`);
      }
      if ((node.type === "tag" || node.type === "universal") && !inside && !here)
        problems.push(`${node.toString().trim()} in ${selectorText}`);
      if (node.type === "pseudo") {
        if (node.value === ":root") problems.push(`:root in ${selectorText}`);
        for (const argument of node.nodes) if (argument.type === "selector") check(argument.nodes, inside || here);
      }
    }
    return { scoped };
  };
  selectorParser((selectors) => {
    selectors.each((selector) => {
      if (!check(selector.nodes, false).scoped) problems.push(`${selector.toString().trim()} is not below .k2-ui`);
    });
  }).processSync(selectorText);
  return problems;
};

test("the namespace guard catches a tag beside a primitive and a tag after a pseudo-class argument", () => {
  expect(namespaceProblems(".k2-ui .k2-table th")).toEqual([]);
  expect(namespaceProblems(".k2-ui .k2-sh > .k2-stile + h3")).toEqual([]);
  expect(namespaceProblems(".k2-ui :where(.k2-table td, .k2-prose ul)")).toEqual([]);
  expect(namespaceProblems(".k2-ui .k2-table + p")).toEqual(["p in .k2-ui .k2-table + p"]);
  expect(namespaceProblems(".k2-ui :not(.k2-x) p")).toEqual(["p in .k2-ui :not(.k2-x) p"]);
});

// The positioning of the behaviour layer writes these on an open popup (and `--keyboard-inset`, the height of an open
// on-screen keyboard, on the toast region, so a toast stays above the keyboard); the page or the platform sets the one
// colour of its app, and the platform may set its readable ink. v2.css may read them, never define them.
const foreignVariables = new Set(["--anchor-width", "--available-height", "--keyboard-inset", "--k2-app", "--k2-app-ink"]);

test("v2.css stays in its namespace below .k2-ui, beside v1", () => {
  const problems: string[] = [];
  root.walkDecls((declaration) => {
    if (declaration.prop.startsWith("--") && !declaration.prop.startsWith("--k2-")) problems.push(`custom property ${declaration.prop}`);
    for (const match of declaration.value.matchAll(/var\(\s*(--[\w-]+)/g))
      if (!match[1]!.startsWith("--k2-") && !foreignVariables.has(match[1]!)) problems.push(`${declaration.prop} reads ${match[1]}`);
  });
  root.walkRules((rule: Rule) => {
    // the steps of a keyframes rule are no selectors
    if (rule.parent?.type === "atrule" && /keyframes$/.test((rule.parent as postcss.AtRule).name)) return;
    problems.push(...namespaceProblems(rule.selector));
  });
  expect(problems).toEqual([]);
});

test("every custom property v2.css reads is one it defines", () => {
  const defined = new Set<string>();
  root.walkDecls((declaration) => {
    if (declaration.prop.startsWith("--")) defined.add(declaration.prop);
  });
  const missing: string[] = [];
  root.walkDecls((declaration) => {
    for (const match of declaration.value.matchAll(/var\(\s*(--[\w-]+)/g))
      if (!defined.has(match[1]!) && !foreignVariables.has(match[1]!)) missing.push(match[1]!);
  });
  expect(missing).toEqual([]);
});

// A line separates two parts of a column. After the last part nothing follows, so that part draws no line under it
// (maintainer, 25.11.: a section's rule under its last row looked like a border). Every part that draws a line under
// itself is named in the rule that takes it away at a column's end, or stands where a column never ends.
test("every part with a line under it draws none as the last part of a column", () => {
  const withLine: string[] = [];
  root.walkRules((rule) => {
    if (rule.parent?.type !== "root") return;
    const match = /^\.k2-ui \.(k2-[a-z-]+)$/.exec(rule.selector);
    if (!match) return;
    rule.walkDecls("border-bottom", (declaration) => {
      if (declaration.value === "var(--k2-hairline)") withLine.push(match[1]!);
    });
  });
  let atEnd = "";
  root.walkRules((rule) => {
    if (rule.selector.includes(".k2-scroll > :is(") && rule.selector.includes(":last-child")) atEnd = rule.selector;
  });
  expect(atEnd).not.toBe("");
  // the head's back link and the filter bar stand above a column's parts; a table ends through `--k2-table-end`
  const neverLast = new Set(["k2-pane-back", "k2-fbar"]);
  const missing = withLine.filter((name) => !neverLast.has(name) && !atEnd.includes(`.${name}`));
  expect(missing).toEqual([]);
  expect(withLine).toContain("k2-sec");
});

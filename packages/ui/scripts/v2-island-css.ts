import postcss from "postcss";
import selectorParser, { type Node, type Selector } from "postcss-selector-parser";
import { v2Parts } from "./v2-parts";

// An island (`<solid-island>`, `<solid-client>` from @k2b/ssr) is a `display: contents` wrapper: boxes ignore it, but
// selectors do not. `.k2-bar-end > .k2-btn`, `:last-child` and `+` see the wrapper as the child or sibling, so a button
// inside a small island loses the rules of its place. The shipped v2.css therefore gets, beside every relation, the
// same relation through one wrapper. The source stays as written; this runs in scripts/build.ts.
//
// Model (islands never nest, so one path through the tree crosses at most one wrapper):
// - `A > B`   also matches `A > W > B`;
// - `A ~ B`   also matches A in a wrapper before B, B in a wrapper after A, or both; it passes any number of empty
//   wrappers (islands that render nothing);
// - `A + B`   the same, with A last and B first in its wrapper, and it steps over up to `MAX_EMPTY` empty wrappers in
//   a row, never over real content. (No selector can say "only empty wrappers between" for any number of them.) Two
//   parts of one primitive, which no island stands between, mark their rule `/* one primitive: … */` and step over
//   none, which keeps the sheet small;
// - `:first-child`, `:last-child`, `:only-child` of an element in a wrapper also need the wrapper in that place, and
//   skip any number of empty wrappers; inside `:has()` they skip none (there they relate the parts of one primitive,
//   such as a seam after a pane or the icon in a button);
// - `:has(> …)`, `:has(+ …)` and `:has(~ …)` look through a wrapper below the anchor, never past the anchor's own wrapper;
// - `:nth-child(1 of S)` and `:nth-last-child(1 of S)` count like `:first-child` and `:last-child` among the siblings that
//   match S;
// - a compound without a class, id, attribute or tag (`*`, `:not(.x)`) never matches the wrapper itself; an `:is()` or
//   `:where()` whose every selector names one counts as naming one;
// - an inner part of a primitive (`parts`, from scripts/v2-parts.ts) is never in a wrapper: a relation to it, from it
//   in a sibling relation, and its first or last place need no wrapper's way;
// - a run of compounds holds at most one sibling relation.
// Every added part sits in `:where()`, so specificity, and with it the cascade, stays exactly as written; without a
// wrapper on the page every rule matches exactly what it matched before. A rule's selector becomes a list of whole
// selectors, one per way its last part crosses a wrapper, never one `:is()` around them all.
// What a browser pays for each form decides the last two points. WebKit sorts a rule by the class of its subject; a
// rule whose subject is one `:is()` of several selectors it checks against every element that changes. And it checks
// a `:has()` whose argument counts siblings with `:nth-*-child(… of S)` again on every change of the page. Both made
// WebKit style a page that redraws an SVG of 300 nodes (the Notebooks graph) about 20 times as long as with the plain
// sheet. Without them it takes less than three times as long, most of it for the ways through a wrapper themselves,
// and a redraw of 300 nodes still fits into a frame; leaving out the ways an inner part never needs saves a fifth of
// that. `src/v2/island-css-cost.browser.test.ts` holds it there (its comment has the measured ratios). So a `:has()`
// whose last-child question is about the app's content, not about parts of one primitive, asks it outside the
// `:has()` (the last but phone forms of a table). A form this cannot make transparent
// (`:nth-*`, `:*-of-type`, `:empty`, a sibling relation inside `:has()` after its first step, also inside `:is()`,
// a `:has()` before a sibling relation, two sibling relations in a row, an escaped pseudo-class)
// fails the build;
// `:nth-*` is allowed on placeholders (`.k2-skel`), which never sit in an island.

const WRAPPER = ":where(solid-island,solid-client)";
const NOT_WRAPPER = ":where(:not(solid-island):not(solid-client))";
const EMPTY = ":where(solid-island:empty,solid-client:empty)";
// A structural pseudo-class that skips empty wrappers. `:nth-child(1 of S)` weighs one pseudo-class plus S, and S is
// all `:where()`, so it weighs exactly what it replaces.
const PLACE: Record<string, string> = {
  ":first-child": `:nth-child(1 of :not(${EMPTY}))`,
  ":last-child": `:nth-last-child(1 of :not(${EMPTY}))`,
  ":only-child": `:nth-child(1 of :not(${EMPTY})):where(:nth-last-child(1 of :not(${EMPTY})))`,
};
const STRUCTURAL = new Set(Object.keys(PLACE));
const LOGICAL = new Set([":is", ":where", ":not", ":matches", ":-webkit-any", ":-moz-any"]);
const PSEUDO_ELEMENTS = new Set([":before", ":after", ":first-line", ":first-letter"]);

/** `internal`: the comment before the rule begins `one primitive:`, so its `+` relates two parts of one primitive. */
type Context = { inHas: boolean; placeholder: boolean; internal: boolean; rule: string; parts: ReadonlySet<string> };
/** `part`: the compound names an inner part of a primitive (`parts`), which no wrapper ever holds. */
type Compound = { body: string; pseudoElement: string; hasHas: boolean; part: boolean };
type Relation = ">" | "+" | "~";
type Variant = "direct" | "wrapped" | "left" | "both";
/** How one relation crosses wrappers; `gap`: the empty wrappers a `+` steps over. */
type Step = { variant: Variant; gap: number };
/** The most empty wrappers in a row that `+` between two primitives steps over. */
export const MAX_EMPTY = 3;

const fail = (context: Context, reason: string): never => {
  throw new Error(`v2.css: ${reason} cannot see through an island wrapper in \`${context.rule}\``);
};

/** Whether a selector's subject names a class, id, tag or attribute, which a wrapper never has (or one of its own). */
const namesSomething = (selector: Selector): boolean => {
  const nodes = selector.nodes;
  let start = nodes.length;
  while (start > 0 && nodes[start - 1]!.type !== "combinator") start--;
  return nodes.slice(start).some((node) => {
    if (node.type === "class" || node.type === "id" || node.type === "attribute") return true;
    if (node.type === "tag") return !/^solid-(island|client)$/i.test(node.value);
    return node.type === "pseudo" && /^:(is|where|matches|-webkit-any)$/i.test(node.value) && node.nodes.every(namesSomething);
  });
};

const compound = (nodes: Node[], context: Context, argument = false): Compound => {
  let body = "";
  let pseudoElement = "";
  let positive = false;
  // an inner part of a primitive is never in a wrapper: its place needs no wrapper's place beside it
  const part = nodes.some((node) => node.type === "class" && context.parts.has(node.value));
  const inWrapper = (place: string) => (part ? "" : `:where(:not(${WRAPPER}>*),${WRAPPER}${place}>*)`);
  for (const node of nodes) {
    if (node.type === "comment") continue;
    if (pseudoElement) {
      pseudoElement += String(node).trim();
      continue;
    }
    if (node.type === "pseudo") {
      const name = node.value.toLowerCase();
      // `:\66 irst-child` is `:first-child`; rather than decode every escape, an escaped name fails.
      if (name.includes("\\")) fail(context, `the escaped pseudo-class ${name}`);
      if (name.startsWith("::") || PSEUDO_ELEMENTS.has(name)) {
        pseudoElement = String(node).trim();
        continue;
      }
      if (STRUCTURAL.has(name)) {
        // inside `:has()` the plain pseudo-class: there skipping empty wrappers would cost every change of the page
        const place = context.inHas ? name : PLACE[name]!;
        body += `${place}${inWrapper(place)}`;
        continue;
      }
      // `:nth-child(1 of S)` and `:nth-last-child(1 of S)`: first or last among the siblings that match S, as
      // `:first-child` and `:last-child` are among all; empty wrappers count as none of S
      const among = /^:nth-(last-)?child\(\s*1\s+of\s+([\s\S]+)\)$/.exec(String(node).trim());
      if (among) {
        const place = `:nth-${among[1] ?? ""}child(1 of :is(${among[2]}):not(${EMPTY}))`;
        body += `${place}${inWrapper(place)}`;
        continue;
      }
      if (/^:nth-|-of-type$|^:empty$/.test(name)) {
        if (!context.placeholder) fail(context, name);
        body += String(node).trim();
        continue;
      }
      if (LOGICAL.has(name)) {
        // `:is(.a, .b)` and `:where(…)` match only what each of their selectors names: a wrapper only if one of them can
        if (name !== ":not" && node.nodes.every(namesSomething)) positive = true;
        body += `${node.value}(${node.nodes.map((inner) => complex(inner, context, true)).join(",")})`;
        continue;
      }
      if (name === ":has") {
        if (context.inHas) fail(context, ":has() inside :has()");
        const inner = { ...context, inHas: true };
        const alternatives: string[] = [];
        // Not past the anchor's own wrapper: `W:has(+ …)` or `W:has(~ …)` would restyle the whole island on every
        // change inside it, on every page (cloud's shell-restyle test). A rule that must see past the wrapper says
        // "the last but popovers" with `:nth-last-child(1 of S)` instead of `:not(:has(~ :not(S)))`.
        for (const argument of node.nodes) alternatives.push(...relativeAlternatives(argument, inner).alternatives);
        body += `:has(${alternatives.join(",")})`;
        continue;
      }
      body += String(node).trim();
      continue;
    }
    if (node.type === "tag" || node.type === "class" || node.type === "id" || node.type === "attribute") positive = true;
    if (node.type === "nesting") fail(context, "nesting");
    body += String(node).trim();
  }
  // The subject of an argument (`:not(:hover)`) is the element of the compound around it, which decides.
  if (!positive && !argument) body += NOT_WRAPPER;
  return { body, pseudoElement, hasHas: body.includes(":has("), part };
};

type Parsed = { lead?: Relation | " "; compounds: Node[][]; combinators: string[] };

const parse = (selector: Selector): Parsed => {
  const parsed: Parsed = { compounds: [], combinators: [] };
  let current: Node[] = [];
  for (const node of selector.nodes) {
    if (node.type !== "combinator") {
      if (node.type !== "comment") current.push(node);
      continue;
    }
    const value = node.value.trim() || " ";
    if (!current.length && !parsed.compounds.length) {
      parsed.lead = value as Relation | " ";
      continue;
    }
    parsed.compounds.push(current);
    parsed.combinators.push(value);
    current = [];
  }
  parsed.compounds.push(current);
  return parsed;
};

/** The chains of one run of compounds joined by `>`, `+` or `~`, each crossing at most one wrapper. */
const run = (compounds: Compound[], relations: Relation[], context: Context, lead?: Relation): string[] => {
  // Relation i stands before compounds[i + offset] (with a lead, relation 0 starts at the anchor of `:has()`).
  const all: Relation[] = lead ? [lead, ...relations] : relations;
  const offset = lead ? 0 : 1;
  // Two sibling relations in a row would need the middle compound in or out of a wrapper on both sides at once.
  if (relations.filter((relation) => relation !== ">").length > 1) fail(context, "two sibling relations in a row");
  const choices = all.map((relation, index): Step[] => {
    // an inner part of a primitive stands where its primitive put it, never in a wrapper
    if (relation === ">" && compounds[index + offset]?.part) return [{ variant: "direct", gap: 0 }];
    if (relation === ">")
      return [
        { variant: "direct", gap: 0 },
        { variant: "wrapped", gap: 0 },
      ];
    // Inside `:has()` only its lead may be a sibling relation; the anchor's side is handled by the `:has()` itself.
    if (context.inHas && !(lead && index === 0)) fail(context, "a sibling relation inside :has() after its first step");
    const left = compounds[index + offset - 1];
    // The left side in a wrapper needs `:has()` around it, and `:has()` does not nest.
    if (left?.hasHas && !context.inHas) fail(context, ":has() before a sibling relation");
    const right = compounds[index + offset];
    // a side that is an inner part of a primitive is never in a wrapper
    const variants = (
      left && !context.inHas ? (["direct", "wrapped", "left", "both"] as Variant[]) : (["direct", "wrapped"] as Variant[])
    ).filter(
      (variant) =>
        !(right?.part && (variant === "wrapped" || variant === "both")) && !(left?.part && (variant === "left" || variant === "both")),
    );
    const gaps = relation === "+" && !context.internal ? Array.from({ length: MAX_EMPTY + 1 }, (_, gap) => gap) : [0];
    return variants.flatMap((variant) => gaps.map((gap) => ({ variant, gap })));
  });
  const combos: Step[][] = [[]];
  for (const options of choices) combos.splice(0, combos.length, ...combos.flatMap((combo) => options.map((option) => [...combo, option])));
  const sibling = (relation?: Relation) => relation === "+" || relation === "~";
  // Compound k in a wrapper as seen from the relation before it (`entered`) and from the sibling relation after it
  // (`leaves`). Both describe the same element, so they must agree: an element in a wrapper between two siblings is
  // first and last in that one wrapper.
  const place = (combo: Step[], k: number) => {
    const before = all[k - offset];
    const after = all[k - offset + 1];
    const into = combo[k - offset]?.variant;
    const out = combo[k - offset + 1]?.variant;
    const entered = !!before && (into === "wrapped" || into === "both");
    const leaves = sibling(after) && (out === "left" || out === "both");
    return { before, after, entered, leaves };
  };
  const kept = combos.filter((combo) => {
    let wrappers = combo.reduce((sum, step) => sum + (step.variant === "direct" ? 0 : step.variant === "both" ? 2 : 1), 0);
    for (let k = 0; k < compounds.length; k++) {
      const { before, after, entered, leaves } = place(combo, k);
      // Siblings inside one wrapper have no wrapper between them, empty or not.
      if (entered && !leaves && after === "+" && (combo[k - offset + 1]?.gap ?? 0) > 0) return false;
      if (!leaves || !before) continue;
      // Under `>` the wrapper takes the element's place (`P > W:has(> B)`), so `>` itself stays direct.
      if (before === ">" && entered) return false;
      if (sibling(before)) {
        if (!entered) return false;
        wrappers--;
      }
    }
    return wrappers <= 1 || (combo.filter((step) => step.variant === "both").length === 1 && wrappers === 2);
  });
  return kept.map((combo) => {
    let chain = "";
    compounds.forEach((part, k) => {
      const { before, after, entered, leaves } = place(combo, k);
      const step = combo[k - offset];
      if (before && step) {
        const relation = before === "+" ? `+${`${EMPTY}+`.repeat(step.gap)}` : before;
        chain += entered && !leaves ? `${relation}${WRAPPER}>` : relation;
      }
      const first = before === "+" && entered ? ":where(:first-child)" : "";
      const last = after === "+" && leaves ? ":where(:last-child)" : "";
      chain += leaves ? `${WRAPPER}:has(>${part.body}${first}${last})` : `${part.body}${first}`;
    });
    return chain.trim();
  });
};

const segments = (parsed: Parsed, context: Context, argument = false) => {
  const last = parsed.compounds.length - 1;
  const compounds = parsed.compounds.map((nodes, index) => compound(nodes, context, argument && index === last));
  const groups: { compounds: Compound[]; relations: Relation[] }[] = [{ compounds: [compounds[0]!], relations: [] }];
  parsed.combinators.forEach((combinator, index) => {
    const part = compounds[index + 1]!;
    if (combinator === " ") groups.push({ compounds: [part], relations: [] });
    else {
      if (combinator !== ">" && combinator !== "+" && combinator !== "~") fail(context, `the combinator ${combinator}`);
      const group = groups.at(-1)!;
      group.compounds.push(part);
      group.relations.push(combinator as Relation);
    }
  });
  return groups;
};

const join = (chains: string[], pseudoElement: string) =>
  chains.length === 1 ? `${chains[0]}${pseudoElement}` : `:is(${chains.join(",")})${pseudoElement}`;

const complex = (selector: Selector, context: Context, argument = false): string => {
  const parsed = parse(selector);
  if (parsed.lead) fail(context, "a relative selector outside :has()");
  return segments(parsed, context, argument)
    .map((group) => join(run(group.compounds, group.relations, context), group.compounds.at(-1)!.pseudoElement))
    .join(" ");
};

const relativeAlternatives = (selector: Selector, context: Context) => {
  const parsed = parse(selector);
  const lead = parsed.lead ?? " ";
  const groups = segments(parsed, context);
  const [head, ...rest] = groups;
  const tail = rest.map((group) => join(run(group.compounds, group.relations, context), group.compounds.at(-1)!.pseudoElement));
  // A relative chain starts with its lead; `run` writes it in front of the first compound.
  const chains =
    lead === " " ? [join(run(head!.compounds, head!.relations, context), "")] : run(head!.compounds, head!.relations, context, lead);
  return { lead, alternatives: chains.map((chain) => [chain, ...tail].join(" ")) };
};

/**
 * A selector of a rule as whole selectors: one for each way its last part (the subject's run of compounds) crosses a
 * wrapper. The parts before it keep their alternatives in `:is()`.
 */
const ruleSelectors = (selector: Selector, context: Context): string[] => {
  const parsed = parse(selector);
  if (parsed.lead) fail(context, "a relative selector outside :has()");
  const groups = segments(parsed, context);
  const subject = groups.at(-1)!;
  const before = groups
    .slice(0, -1)
    .map((group) => join(run(group.compounds, group.relations, context), group.compounds.at(-1)!.pseudoElement))
    .join(" ");
  return run(subject.compounds, subject.relations, context).map(
    (chain) => `${before ? `${before} ` : ""}${chain}${subject.compounds.at(-1)!.pseudoElement}`,
  );
};

/** v2.css as it ships: every relation also holds through one island wrapper, except where an inner part needs none. */
export const shippedV2Css = (css: string): string => transparentIslands(css, v2Parts());

/** `css` with every relation also through one island wrapper; `parts`: the inner parts of primitives, which need none. */
export const transparentIslands = (css: string, parts: ReadonlySet<string> = new Set()): string => {
  const root = postcss.parse(css);
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes$/i.test((rule.parent as postcss.AtRule).name)) return;
    const marker = rule.prev();
    const internal = marker?.type === "comment" && /^one primitive:\s*\S/.test(marker.text);
    const selectors = selectorParser().astSync(rule.selector);
    rule.selector = selectors.nodes
      .flatMap((selector) => {
        const text = String(selector).trim();
        return ruleSelectors(selector, { inHas: false, placeholder: text.includes(".k2-skel"), internal, rule: text, parts });
      })
      .join(",\n");
  });
  return root.toString();
};

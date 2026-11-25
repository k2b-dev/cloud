import postcss from "postcss";
import selectorParser, { type Node, type Selector } from "postcss-selector-parser";

// An island (`<solid-island>`, `<solid-client>` from @k2b/ssr) is a `display: contents` wrapper: boxes ignore it, but
// selectors do not. `.k2-bar-end > .k2-btn`, `:last-child` and `+` see the wrapper as the child or sibling, so a button
// inside a small island loses the rules of its place. The shipped v2.css therefore gets, beside every relation, the
// same relation through one wrapper. The source stays as written; this runs in scripts/build.ts.
//
// Model (islands never nest, so one path through the tree crosses at most one wrapper):
// - `A > B`   also matches `A > W > B`;
// - `A + B`   also matches A last in a wrapper before B, B first in a wrapper after A, or both;
// - `A ~ B`   the same, without first and last;
// - `:first-child`, `:last-child`, `:only-child` of an element in a wrapper also need the wrapper in that place;
// - `:has(> …)`, `:has(+ …)` and `:has(~ …)` look through a wrapper, and an anchor in a wrapper looks past it;
// - a compound without a class, id, attribute or tag (`*`, `:not(.x)`) never matches the wrapper itself.
// Every added part sits in `:where()`, so specificity, and with it the cascade, stays exactly as written; without a
// wrapper on the page every rule matches exactly what it matched before. A form this cannot make transparent
// (`:nth-*`, `:*-of-type`, `:empty`, a sibling relation inside `:has()` after its first step) fails the build;
// `:nth-*` is allowed on placeholders (`.k2-skel`), which never sit in an island.

const WRAPPER = ":where(solid-island,solid-client)";
const NOT_WRAPPER = ":where(:not(solid-island):not(solid-client))";
const STRUCTURAL = new Set([":first-child", ":last-child", ":only-child"]);
const LOGICAL = new Set([":is", ":where", ":not", ":matches", ":-webkit-any", ":-moz-any"]);
const PSEUDO_ELEMENTS = new Set([":before", ":after", ":first-line", ":first-letter"]);

type Context = { inHas: boolean; placeholder: boolean; rule: string };
type Compound = { body: string; pseudoElement: string; hasHas: boolean };
type Relation = ">" | "+" | "~";
type Variant = "direct" | "wrapped" | "left" | "both";

const fail = (context: Context, reason: string): never => {
  throw new Error(`v2.css: ${reason} cannot see through an island wrapper in \`${context.rule}\``);
};

const compound = (nodes: Node[], context: Context, argument = false): Compound => {
  let body = "";
  let pseudoElement = "";
  let positive = false;
  for (const node of nodes) {
    if (node.type === "comment") continue;
    if (pseudoElement) {
      pseudoElement += String(node).trim();
      continue;
    }
    if (node.type === "pseudo") {
      const name = node.value.toLowerCase();
      if (name.startsWith("::") || PSEUDO_ELEMENTS.has(name)) {
        pseudoElement = String(node).trim();
        continue;
      }
      if (STRUCTURAL.has(name)) {
        body += `${name}:where(:not(${WRAPPER}>*),${WRAPPER}${name}>*)`;
        continue;
      }
      if (/^:nth-|-of-type$|^:empty$/.test(name)) {
        if (!context.placeholder) fail(context, name);
        body += String(node).trim();
        continue;
      }
      if (LOGICAL.has(name)) {
        body += `${node.value}(${node.nodes.map((inner) => complex(inner, context, true)).join(",")})`;
        continue;
      }
      if (name === ":has") {
        if (context.inHas) fail(context, ":has() inside :has()");
        const inner = { ...context, inHas: true };
        const alternatives: string[] = [];
        const pastWrapper: string[] = [];
        for (const argument of node.nodes) {
          const relative = relativeAlternatives(argument, inner);
          alternatives.push(...relative.alternatives);
          // An anchor in a wrapper: what follows the wrapper follows the anchor too.
          if (relative.lead === "+") pastWrapper.push(`${WRAPPER}:has(${relative.alternatives.join(",")})>:where(:last-child)`);
          if (relative.lead === "~") pastWrapper.push(`${WRAPPER}:has(${relative.alternatives.join(",")})>*`);
        }
        const has = `:has(${alternatives.join(",")})`;
        body += pastWrapper.length ? `:is(${[has, ...pastWrapper].join(",")})` : has;
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
  return { body, pseudoElement, hasHas: body.includes(":has(") };
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
  // Relation i stands before compounds[i] (with a lead, relation 0 starts at the anchor of `:has()`).
  const all: Relation[] = lead ? [lead, ...relations] : relations;
  const offset = lead ? 0 : 1;
  const choices = all.map((relation, index): Variant[] => {
    if (relation === ">") return ["direct", "wrapped"];
    const left = compounds[index + offset - 1];
    // The left side in a wrapper needs `:has()`; inside `:has()` the anchor's side is handled by the `:has()` itself.
    if (!left || context.inHas || left.hasHas) return ["direct", "wrapped"];
    return ["direct", "wrapped", "left", "both"];
  });
  const combos: Variant[][] = [[]];
  for (const options of choices) combos.splice(0, combos.length, ...combos.flatMap((combo) => options.map((option) => [...combo, option])));
  const kept = combos.filter((combo) => {
    const wrappers = combo.reduce((sum, variant) => sum + (variant === "direct" ? 0 : variant === "both" ? 2 : 1), 0);
    return wrappers <= 1 || (combo.filter((variant) => variant === "both").length === 1 && wrappers === 2);
  });
  return kept.map((combo) => {
    let chain = "";
    compounds.forEach((part, index) => {
      const relationIndex = index - offset;
      const relation = all[relationIndex];
      const variant = combo[relationIndex];
      if (relation && variant) {
        const through = variant === "wrapped" || variant === "both";
        chain += relation === ">" ? (through ? `>${WRAPPER}>` : ">") : through ? `${relation}${WRAPPER}>` : relation;
      }
      const next = all[relationIndex + 1];
      const nextVariant = combo[relationIndex + 1];
      const first = relation === "+" && (variant === "wrapped" || variant === "both") ? ":where(:first-child)" : "";
      if (next && next !== ">" && (nextVariant === "left" || nextVariant === "both"))
        chain += `${WRAPPER}:has(>${part.body}${first}${next === "+" ? ":where(:last-child)" : ""})`;
      else chain += `${part.body}${first}`;
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
  if (groups.some((group) => group.relations.some((relation) => relation !== ">")))
    fail(context, "a sibling relation inside :has() after its first step");
  const [head, ...rest] = groups;
  const tail = rest.map((group) => join(run(group.compounds, group.relations, context), group.compounds.at(-1)!.pseudoElement));
  // A relative chain starts with its lead; `run` writes it in front of the first compound.
  const chains =
    lead === " " ? [join(run(head!.compounds, head!.relations, context), "")] : run(head!.compounds, head!.relations, context, lead);
  return { lead, alternatives: chains.map((chain) => [chain, ...tail].join(" ")) };
};

/** v2.css as it ships: every relation also holds through one island wrapper. */
export const transparentIslands = (css: string): string => {
  const root = postcss.parse(css);
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes$/i.test((rule.parent as postcss.AtRule).name)) return;
    const selectors = selectorParser().astSync(rule.selector);
    rule.selector = selectors.nodes
      .map((selector) => {
        const text = String(selector).trim();
        return complex(selector, { inHas: false, placeholder: text.includes(".k2-skel"), rule: text });
      })
      .join(",\n");
  });
  return root.toString();
};

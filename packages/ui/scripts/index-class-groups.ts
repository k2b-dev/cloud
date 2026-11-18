import postcss from "postcss";
import selectorParser, { type Selector } from "postcss-selector-parser";

// The current stylesheet needs at most 33 alternatives per selector; cap growth below twice that.
// Larger Cartesian products retain their original grouping and browser fallbacks.
const MAX_ALTERNATIVES = 64;
const isClassGroup = (node: selectorParser.Node): node is selectorParser.Pseudo =>
  selectorParser.isPseudo(node) &&
  [":is", ":-webkit-any", ":-moz-any"].includes(node.value.toLowerCase()) &&
  node.nodes.length > 1 &&
  node.nodes.every((branch) => branch.nodes.length === 1 && selectorParser.isClassName(branch.nodes[0]));

// Only distribute top-level groups of individual classes: their specificity is identical.
// Nested :not/:has/:where, IDs and complex alternatives retain their existing semantics.
const expand = (selector: Selector, budget = MAX_ALTERNATIVES): Selector[] => {
  const index = selector.nodes.findIndex(isClassGroup);
  const group = selector.nodes[index];
  if (!group || !selectorParser.isPseudo(group)) return [selector];
  if (group.nodes.length > budget) return [selector];
  let alternatives = 1;
  for (const node of selector.nodes) {
    if (isClassGroup(node)) alternatives *= node.nodes.length;
    if (alternatives > budget) return [selector];
  }
  return group.nodes.flatMap((branch) => {
    const alternative = branch.nodes[0];
    if (!alternative) throw new Error("Missing class alternative");
    const replacement = alternative.clone();
    replacement.spaces = { ...group.spaces };
    const expanded = selector.clone();
    const target = expanded.nodes[index];
    if (!target) throw new Error("Missing class group");
    target.replaceWith(replacement);
    return expand(expanded, budget / group.nodes.length);
  });
};

/** Preserve the browser compatibility target while exposing classes to selector indexing. */
export const indexClassGroups = (css: string): string => {
  const root = postcss.parse(css);
  root.walkRules((rule) => {
    if (!/:(?:is|-webkit-any|-moz-any)\(/i.test(rule.selector)) return;
    const selectors = selectorParser().astSync(rule.selector);
    const branches = selectors.nodes.flatMap((selector) => expand(selector));
    selectors.removeAll();
    for (const branch of branches) selectors.append(branch);
    rule.selector = selectors.toString();
  });
  return root.toString();
};

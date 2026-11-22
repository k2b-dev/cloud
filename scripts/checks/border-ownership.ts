import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "@typescript/typescript6";
import { workspacePackages } from "../workspace";
import { compareBaseline, type KeyedFinding } from "./baseline";
import { isTestFile, listFiles, parseSource } from "./files";
import type { Rule } from "./rule";

/**
 * "One line, one owner" (Cloud flach K2): the container draws the divider between its children (`k2b-divided`), the
 * column boundary draws the column line, the head draws the head line. A component draws no outer edge of its own,
 * unless it is framed by definition: field, button, card, overlay, chip, or area. Otherwise two neighbours draw the
 * same line twice.
 *
 * As an approximation, this rule reports an outer border (`border`, `border-top|right|bottom|left`,
 * `border-block|inline[-start|-end]`) on a component root in @k2b/ui CSS (a selector that ends on a `.k2b-<block>`
 * class without `__`), and a Tailwind border width class (`border`, `border-t`, `border-x-2`, …) on the root element of
 * a JSX tree in an application. Framed elements, matched by the patterns below, are allowed. Known findings live in
 * `border-ownership.baseline`; migrations remove lines, the rule never adds one. `layoutProblems` measures the rest in
 * the browser.
 */
const RULE = "border-ownership";
const HEADER = [
  "Known outer borders outside framed elements (K2, one line, one owner), one per occurrence:",
  "<file> | <css|class> | <selector or tag> <property or class>. Lanes remove lines as containers take the lines over.",
  "`bun scripts/check.ts border-ownership --fix` removes lines whose finding is gone.",
];
const message =
  "a component draws no outer edge of its own; let its container draw the line (`k2b-divided`, the column boundary, the head) or use a framed element; see /en/ui/surfaces/flat-criteria (K2)";

/** Framed by definition: field, button, card, overlay, chip, area, and their usual names. */
export const FRAMED =
  /(?:^|[-_])(?:field|input|textarea|select|combobox|button|btn|card|tile|menu|dropdown|popover|dialog|sheet|toast|tooltip|hover-card|chip|badge|tag|pill|area|switch|checkbox|radio|kbd|swatch|toolbar|segmented|picker|calendar-event|window|overlay|popup|dropzone|avatar|control)(?:$|[-_])/;

const OUTER = /^border(?:-(?:top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end))?$/;
const NO_LINE = /^(?:none|0|0px|hidden|initial|unset|inherit|revert)$|(?:^|\s)(?:none|hidden|transparent)(?:\s|$)|^0(?:px)?\s/;

const blankComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length;

/** The block class a selector part ends on, such as `k2b-paper` in `.k2b-ui .k2b-paper[data-x]:hover`. */
const rootBlock = (part: string): string | undefined => {
  const last =
    part
      .trim()
      .split(/[\s>+~]+/)
      .at(-1) ?? "";
  if (/::?(?:before|after)|:(?:first|last|nth)-/.test(last)) return undefined;
  const classes = [...last.matchAll(/\.(k2b-[\w-]+)/g)].map((match) => match[1]!);
  const block = classes.at(-1);
  return block && !block.includes("__") && block !== "k2b-ui" ? block : undefined;
};

export const cssFindings = (path: string, file: string, original: string): KeyedFinding[] => {
  const source = blankComments(original);
  const findings: KeyedFinding[] = [];
  for (const match of source.matchAll(/(?<=[{;]\s*)([\w-]+)\s*:\s*([^;{}]*)/g)) {
    const property = match[1]!;
    const value = (match[2] ?? "").replace(/!important/i, "").trim();
    if (!OUTER.test(property) || NO_LINE.test(value)) continue;
    const at = match.index ?? 0;
    const open = source.lastIndexOf("{", at);
    const selector = source
      .slice(Math.max(source.lastIndexOf("}", open), source.lastIndexOf(";", open), source.lastIndexOf("{", open - 1)) + 1, open)
      .trim()
      .replace(/\s+/g, " ");
    const blocks = selector.split(",").map(rootBlock);
    if (blocks.some((block) => block === undefined || FRAMED.test(block))) continue;
    findings.push({
      file,
      line: lineOf(original, at),
      key: `${path} | css | ${selector} ${property}`,
      message: `${selector} sets ${property}: ${value}: ${message}`,
    });
  }
  return findings;
};

/** A Tailwind border width utility, with any variant: `border`, `border-t`, `md:border-x-2`, `border-[1px]`. */
const BORDER_WIDTH = /^(?:[\w-]+:)*!?border(?:-[trblxyse])?(?:-(?:2|4|8|\[[^\]]+\]))?$/;

const classTokens = (initializer: ts.JsxAttributeValue): string[] => {
  const tokens: string[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      tokens.push(...node.text.split(/\s+/).filter(Boolean));
    ts.forEachChild(node, collect);
  };
  collect(initializer);
  return tokens;
};

const isJsx = (node: ts.Node) => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);

export const sourceFindings = (path: string, file: string, source: string): KeyedFinding[] => {
  if (!source.includes("border")) return [];
  const { sourceFile } = parseSource(file, source);
  const findings: KeyedFinding[] = [];
  const visit = (node: ts.Node, insideJsx: boolean): void => {
    const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : undefined;
    if (opening && !insideJsx) {
      const tag = opening.tagName.getText();
      const attribute = opening.attributes.properties.find(
        (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && ["class", "className"].includes(property.name.getText()),
      );
      const tokens = attribute?.initializer ? classTokens(attribute.initializer) : [];
      const framed = /^(?:input|button|textarea|select)$/.test(tag) || tokens.some((token) => FRAMED.test(token));
      if (!framed)
        for (const token of tokens.filter((token) => BORDER_WIDTH.test(token)))
          findings.push({
            file,
            line: sourceFile.getLineAndCharacterOfPosition(opening.getStart(sourceFile)).line + 1,
            key: `${path} | class | <${tag}> ${token}`,
            message: `<${tag}> roots a component with ${token}: ${message}`,
          });
    }
    ts.forEachChild(node, (child) => visit(child, insideJsx || isJsx(node)));
  };
  visit(sourceFile, false);
  return findings;
};

export const collectBorderFindings = (workspaceRoot: string): KeyedFinding[] => {
  const ui = listFiles(join(workspaceRoot, "packages/ui/src/styles"), /\.css$/).map((file) => ({ file, css: true }));
  const apps = workspacePackages(workspaceRoot)
    .filter((pkg) => !pkg.startsWith("packages/ui") && !pkg.startsWith("packages/ssr") && !pkg.startsWith("packages/editor"))
    .flatMap((pkg) => listFiles(join(workspaceRoot, pkg, "src"), /\.tsx$/))
    .filter((file) => !isTestFile(file) && !/browser-harness|browser-fixture|browser-suite/.test(file))
    .map((file) => ({ file, css: false }));
  return [...ui, ...apps]
    .sort((a, b) => a.file.localeCompare(b.file))
    .flatMap(({ file, css }) => {
      const path = relative(workspaceRoot, file);
      const source = readFileSync(file, "utf8");
      return css ? cssFindings(path, file, source) : sourceFindings(path, file, source);
    });
};

export const rule: Rule = {
  name: RULE,
  description: "One line, one owner: no outer border on a component root outside framed elements (K2); known findings in a baseline",
  run: async ({ workspaceRoot, fix }) => compareBaseline(workspaceRoot, RULE, HEADER, collectBorderFindings(workspaceRoot), fix),
};

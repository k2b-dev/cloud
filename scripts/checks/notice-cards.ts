import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "@typescript/typescript6";
import { compareBaseline, type KeyedFinding } from "./baseline";
import { isTestFile, listFiles, parseSource } from "./files";
import type { Finding, Rule } from "./rule";

const RULE = "notice-cards";
const HEADER = [
  "Known frames around a notice (K10, K14), one per occurrence: <file> | frame | <parent>.",
  "Lanes remove lines as the notice becomes the cell itself; the rule never adds lines.",
  "`bun scripts/check.ts notice-cards --fix` removes lines whose finding is gone.",
];
/** Wrappers that draw nothing themselves: the frame question goes to the element above them. */
const PASS_THROUGH = new Set(["Show", "Match", "Switch", "Suspense", "ErrorBoundary", "For", "Index", "Dynamic"]);
/** Components that are a frame of their own. */
const FRAMES = new Set(["Paper", "LinkCard", "ResourceCard", "Card"]);
/** A class token that draws an edge all around, a fill, a radius, or a shadow; a one-sided line is a row line, not a frame. */
const FRAME_TOKEN =
  /^(?:[\w-]+:)*!?(?:border(?:-(?![trblxyse](?:-|$))(?!0$|none$|transparent$)[\w./[\]%-]+)?|ring(?:-[\w./[\]%-]+)?|rounded(?:-(?!none\b)[\w[\]%.-]+)?|bg-(?!transparent\b|none\b)[\w./[\]%()-]+|shadow(?:-(?!none\b)[\w[\]-]+)?)$/;

/** Controls inside a notice may keep their icons; anywhere else an icon is decoration. */
const CONTROLS = new Set(["Button", "ButtonLink", "IconButton", "IconButtonLink", "SplitButton", "button", "a"]);
/** NoticeRow is the one-line form of a notice and keeps the same calm content; its tile is a prop, not a child. */
const NOTICES = new Set(["NoticeCard", "NoticeRow"]);
/** Own text sizes, faded text, and palette colours, with any variant prefix such as `dark:` or `hover:`. */
const OVERRIDE =
  /^(?:[\w-]+:)*(?:text-(?:xs|sm|base|lg|\[[^\]]*\])|opacity-\S+|(?:bg|text|border)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\S+)$/;

// A control glyph has its own legible size; arbitrary colour utilities remain forbidden.
const ICON_SIZE = /^(?:[\w-]+:)*text-(?:xs|sm|base|lg|\[(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em)\])$/;

const tagName = (node: ts.Node): string | undefined => {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
  return undefined;
};

/** Class tokens written in a `class` or `bodyClass` value, including string parts of expressions. */
const classTokens = (initializer: ts.JsxAttributeValue): string[] => {
  const tokens: string[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      tokens.push(...node.text.split(/\s+/).filter(Boolean));
    }
    ts.forEachChild(node, collect);
  };
  collect(initializer);
  return tokens;
};

/** JSX children that render something: elements and expressions, not whitespace text. */
const drawnChildren = (element: ts.JsxElement): ts.Node[] =>
  element.children.filter((child) => !(ts.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces));

/**
 * The parent that frames a notice when the notice is its only drawn child: a frame component, or an element whose
 * class draws an edge, fill, radius, or shadow. Control-flow wrappers in between are looked through.
 */
const frameAround = (notice: ts.Node): string | undefined => {
  let child: ts.Node = notice;
  for (let parent = notice.parent; parent; parent = parent.parent) {
    if (ts.isJsxFragment(parent) || ts.isJsxExpression(parent) || ts.isParenthesizedExpression(parent)) {
      child = parent;
      continue;
    }
    if (!ts.isJsxElement(parent)) return undefined;
    if (drawnChildren(parent).length !== 1 || drawnChildren(parent)[0] !== child) return undefined;
    const tag = parent.openingElement.tagName.getText();
    if (PASS_THROUGH.has(tag)) {
      child = parent;
      continue;
    }
    const classAttribute = parent.openingElement.attributes.properties.find(
      (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && ["class", "className"].includes(property.name.getText()),
    );
    const frameClasses = classAttribute?.initializer
      ? classTokens(classAttribute.initializer).filter((token) => FRAME_TOKEN.test(token))
      : [];
    if (FRAMES.has(tag) || frameClasses.length > 0)
      return frameClasses.length > 0 ? `<${tag} class="${frameClasses.join(" ")}">` : `<${tag}>`;
    return undefined;
  }
  return undefined;
};

/**
 * Every NoticeCard has one calm look: a tone tint, the title in primary ink,
 * and the rest in secondary ink at the reading size. A call site that adds a
 * decorative icon, its own text size, faded text, or palette colours inside a
 * notice brings back a second look.
 */
export const rule: Rule = {
  name: "notice-cards",
  description: "NoticeCard content adds no decorative icon, text size, opacity, or palette colour; no frame around a notice",
  run: async ({ workspaceRoot, fix }) => {
    const sourceRoots = [join(workspaceRoot, "packages"), join(workspaceRoot, "pwas"), join(workspaceRoot, "docs-site", "src")];
    const findings: Finding[] = [];
    const framed: KeyedFinding[] = [];

    for (const file of sourceRoots.flatMap((root) => listFiles(root, /\.tsx$/)).sort()) {
      if (isTestFile(file)) continue;
      const source = readFileSync(file, "utf8");
      if (!source.includes("<NoticeCard") && !source.includes("<NoticeRow")) continue;
      const path = relative(workspaceRoot, file);
      const { sourceFile, findings: unparsed } = parseSource(file, source);
      findings.push(...unparsed);
      const lineOf = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

      const visit = (node: ts.Node, inNotice: boolean, inControl: boolean, inControlIcon: boolean): void => {
        const tag = tagName(node);
        if (tag !== undefined && NOTICES.has(tag) && !inNotice) {
          const frame = frameAround(node);
          if (frame)
            framed.push({
              file,
              line: lineOf(node),
              key: `${path} | frame | ${frame}`,
              message: `${tag} is the only child of ${frame}: a notice is the cell itself, never a box in a box; drop the frame (K10, K14).`,
            });
        }
        const notice = inNotice || (tag !== undefined && NOTICES.has(tag));
        const control = inControl || (tag !== undefined && CONTROLS.has(tag));
        const controlIcon = tag === undefined ? inControlIcon : control && tag === "i";
        if (notice && tag === "i" && !control) {
          findings.push({
            file,
            line: lineOf(node),
            message: "Decorative icon in a NoticeCard: notices have no icon; let the words carry the meaning.",
          });
        }
        if (notice && ts.isJsxAttribute(node) && node.initializer && ["class", "bodyClass"].includes(node.name.getText())) {
          const overrides = classTokens(node.initializer).filter(
            (token) => OVERRIDE.test(token) && !(controlIcon && ICON_SIZE.test(token)),
          );
          if (overrides.length > 0) {
            findings.push({
              file,
              line: lineOf(node),
              message: `${overrides.join(" ")} inside a NoticeCard: notice content keeps the shared size and ink; use title, detail, or text-primary/text-dimmed.`,
            });
          }
        }
        ts.forEachChild(node, (child) => visit(child, notice, control, controlIcon));
      };
      visit(sourceFile, false, false, false);
    }
    return [...findings, ...compareBaseline(workspaceRoot, RULE, HEADER, framed, fix)];
  },
};

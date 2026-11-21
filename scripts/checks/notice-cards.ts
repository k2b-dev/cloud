import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { isTestFile, listFiles, parseSource } from "./files";
import type { Finding, Rule } from "./rule";

/** Controls inside a notice may keep their icons; anywhere else an icon is decoration. */
const CONTROLS = new Set(["Button", "ButtonLink", "IconButton", "IconButtonLink", "SplitButton", "button", "a"]);
/** NoticeRow is the one-line form of a notice and keeps the same calm content; its tile is a prop, not a child. */
const NOTICES = new Set(["NoticeCard", "NoticeRow"]);
/** Own text sizes, faded text, and palette colours, with any variant prefix such as `dark:` or `hover:`. */
const OVERRIDE =
  /^(?:[\w-]+:)*(?:text-(?:xs|sm|base|lg|\[[^\]]*\])|opacity-\S+|(?:bg|text|border)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\S+)$/;

// A control glyph has its own legible size; arbitrary colour utilities remain forbidden.
const ICON_SIZE = /^(?:[\w-]+:)*text-(?:xs|sm|base|lg|\[(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em)\])$/;

/** A rounded corner and a border on one element draw a box (K14). */
const FRAME_RADIUS = /^(?:[\w-]+:)*rounded(?:-(?:sm|md|lg|xl|2xl|3xl|\[[^\]]*\]))?$/;
const FRAME_BORDER = /^(?:[\w-]+:)*border(?:-(?:2|4|8|\[[^\]]*\]))?$/;

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

/** The class tokens of an element's own `class` or `className`. */
const ownClassTokens = (node: ts.JsxElement): string[] =>
  node.openingElement.attributes.properties
    .filter(ts.isJsxAttribute)
    .filter((attr) => ["class", "className"].includes(attr.name.getText()) && attr.initializer)
    .flatMap((attr) => (attr.initializer ? classTokens(attr.initializer) : []));

/** The JSX elements among an element's children, ignoring text and whitespace. */
const childElements = (node: ts.JsxElement): ts.Node[] =>
  node.children.filter((child) => ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxExpression(child));

/**
 * Every NoticeCard has one calm look: a tone tint, the title in primary ink,
 * and the rest in secondary ink at the reading size. A call site that adds a
 * decorative icon, its own text size, faded text, or palette colours inside a
 * notice brings back a second look.
 */
export const rule: Rule = {
  name: "notice-cards",
  description: "NoticeCard content adds no decorative icon, text size, opacity, or palette colour",
  run: async ({ workspaceRoot }) => {
    const sourceRoots = [join(workspaceRoot, "packages"), join(workspaceRoot, "pwas"), join(workspaceRoot, "docs-site", "src")];
    const findings: Finding[] = [];

    for (const file of sourceRoots.flatMap((root) => listFiles(root, /\.tsx$/)).sort()) {
      if (isTestFile(file)) continue;
      const source = readFileSync(file, "utf8");
      if (!source.includes("<NoticeCard") && !source.includes("<NoticeRow")) continue;
      const { sourceFile, findings: unparsed } = parseSource(file, source);
      findings.push(...unparsed);
      const lineOf = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

      const visit = (node: ts.Node, inNotice: boolean, inControl: boolean, inControlIcon: boolean): void => {
        const tag = tagName(node);
        const notice = inNotice || (tag !== undefined && NOTICES.has(tag));
        // K14: a notice is the tinted cell itself. A box whose only content is a notice (a rounded, bordered element or
        // a Paper) draws a second frame around it.
        if (!inNotice && ts.isJsxElement(node)) {
          const kids = childElements(node);
          const only = kids.length === 1 ? tagName(kids[0]!) : undefined;
          const tokens = ownClassTokens(node);
          const framed =
            tag === "Paper" || (tokens.some((token) => FRAME_RADIUS.test(token)) && tokens.some((token) => FRAME_BORDER.test(token)));
          if (only !== undefined && NOTICES.has(only) && framed) {
            findings.push({
              file,
              line: lineOf(node),
              message: `Frame around a ${only}: the notice is the tinted cell; drop the ${tag === "Paper" ? "Paper" : "border and radius"} around it (K14).`,
            });
          }
        }
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
    return findings;
  },
};

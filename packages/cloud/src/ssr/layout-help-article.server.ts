import type * as Htmlparser2 from "htmlparser2";
import type { HelpArticleParts } from "./layout-help-article";

// Keep the same synchronous import path as sanitize-html (see ai/readable-html.ts).
const { parseDocument, DomUtils, ElementType }: typeof Htmlparser2 = require("htmlparser2");
type HtmlNode = ReturnType<typeof parseDocument>["children"][number];

const insideDetails = (node: HtmlNode): boolean => {
  for (let parent = node.parent; parent; parent = parent.parent) if ("name" in parent && parent.name === "details") return true;
  return false;
};
const spokenText = (node: HtmlNode): string => {
  if (node.type === ElementType.Text) return node.data;
  if (!("children" in node)) return "";
  return node.children
    .filter((child) => !("attribs" in child) || child.attribs["aria-hidden"] !== "true")
    .map(spokenText)
    .join("");
};

/** Server-only equivalent of the browser's inert-template splitter. Never import into an island. */
export const helpArticlePartsServer = (html: string): HelpArticleParts => {
  const body = parseDocument(html);
  const first = body.children.find((node) => "attribs" in node);
  const lead = first?.name === "p" && !first.attribs.class ? DomUtils.getOuterHTML(first) : undefined;
  if (lead && first) DomUtils.removeElement(first);
  const elements = DomUtils.findAll(() => true, body.children);
  return {
    lead,
    body: DomUtils.getInnerHTML(body),
    sections: elements
      .filter((element) => element.name === "h2" && "id" in element.attribs && !insideDetails(element))
      .map((element) => ({ id: element.attribs.id ?? "", label: spokenText(element).replace(/\s+/g, " ").trim() }))
      .filter((section) => section.label),
    steps: elements.filter((element) => {
      const list = element.parent;
      const wrapper = list?.parent;
      return (
        element.name === "li" &&
        list &&
        "name" in list &&
        list.name === "ol" &&
        wrapper &&
        "attribs" in wrapper &&
        (wrapper.attribs.class ?? "").split(/\s+/).includes("help-steps") &&
        !insideDetails(element)
      );
    }).length,
  };
};

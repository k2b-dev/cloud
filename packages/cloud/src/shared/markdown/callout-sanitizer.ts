import { MARKDOWN_CALLOUT_ICON_ATTRIBUTES } from "@k2b/ui";
import type sanitizeHtml from "sanitize-html";

/** Fresh sanitize-html options for one document: SVG is limited to fixed callout icons. */
export const markdownCalloutSanitizeOptions = () => {
  const elements: { inIcon: boolean; discard: boolean }[] = [];
  let closed: { inIcon: boolean; discard: boolean } | undefined;
  return {
    allowedTags: ["svg", "path"],
    allowedAttributes: { svg: Object.keys(MARKDOWN_CALLOUT_ICON_ATTRIBUTES), path: ["d"] },
    // onOpenTag sees raw attributes before transforms; discarded SVG must keep ordinary HTML and text.
    onOpenTag: (tag, attrs) => {
      const parent = elements.at(-1);
      elements.push({
        inIcon: !!parent?.inIcon || (tag === "svg" && attrs.class === MARKDOWN_CALLOUT_ICON_ATTRIBUTES.class),
        discard: !!parent?.discard || (!!parent?.inIcon && tag !== "path"),
      });
    },
    // sanitize-html closes a tag before calling exclusiveFilter for that element.
    onCloseTag: () => {
      closed = elements.pop();
    },
    // excludeTag preserves ordinary content, including after an unclosed author SVG.
    exclusiveFilter: ({ tag }) => closed?.discard || ((tag === "svg" || tag === "path") && !closed?.inIcon ? "excludeTag" : false),
    textFilter: (text) => (elements.at(-1)?.inIcon ? "" : text),
    transformTags: {
      svg: (tagName) => ({
        tagName,
        attribs: { ...MARKDOWN_CALLOUT_ICON_ATTRIBUTES },
      }),
      path: (tagName, attrs) => ({
        tagName,
        attribs: Object.fromEntries(Object.entries(attrs).filter(([name]) => name === "d")),
      }),
    },
  } satisfies sanitizeHtml.IOptions;
};

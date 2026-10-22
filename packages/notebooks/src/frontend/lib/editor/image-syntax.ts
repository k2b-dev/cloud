import type { MarkdownConfig } from "@lezer/markdown";
import { parseSizedMarkdownImage } from "../../../lib/markdown-image";

export const sizedImageSyntax: MarkdownConfig = {
  parseInline: [
    {
      name: "SizedImage",
      before: "Image",
      parse(cx, next, pos) {
        if (next !== 33 || cx.char(pos + 1) !== 91) return -1;
        const image = parseSizedMarkdownImage(cx.slice(pos, cx.end));
        if (!image) return -1;
        const { length, hrefFrom, hrefTo, titleFrom, titleTo } = image;
        const children = [
          cx.elt("LinkMark", pos, pos + 2),
          cx.elt("LinkMark", pos + hrefFrom - 2, pos + hrefFrom - 1),
          cx.elt("LinkMark", pos + hrefFrom - 1, pos + hrefFrom),
          cx.elt("URL", pos + hrefFrom, pos + hrefTo),
        ];
        if (titleFrom !== null && titleTo !== null) children.push(cx.elt("LinkTitle", pos + titleFrom, pos + titleTo));
        children.push(cx.elt("LinkMark", pos + length - 1, pos + length));
        return cx.addElement(cx.elt("Image", pos, pos + length, children));
      },
    },
  ],
};

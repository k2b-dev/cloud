/**
 * Info Blocks Extension for Marked
 *
 * Renders custom info blocks with syntax:
 * :::note
 * Content here
 * :::
 *
 * The type follows the colons directly — `::: note` with a space does not
 * match. An optional argument after the type overrides the label:
 * `:::warning Before deleting`.
 *
 * Supported types: note, info, success, warning, danger
 */

import { NOTICE_CARD_CLASSES, NOTICE_CARD_ICONS, type NoticeTone } from "@k2b/ui";
import type { MarkedExtension, Tokens } from "marked";
import { escapeHtml } from "../shared";

type BlockType = "note" | "info" | "success" | "warning" | "danger";

const blockConfig: Record<BlockType, { label: string; tone: NoticeTone }> = {
  note: {
    label: "Note",
    tone: "neutral",
  },
  info: {
    label: "Info",
    tone: "info",
  },
  success: {
    label: "Success",
    tone: "success",
  },
  warning: {
    label: "Warning",
    tone: "warning",
  },
  danger: {
    label: "Danger",
    tone: "danger",
  },
};

const renderInlineContent = (content: string): string => {
  return content
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, '<code class="bg-black/10 dark:bg-white/10 px-1 py-0.5 rounded text-sm">$1</code>')
    .replace(/\n/g, "<br>");
};

export function infoBlocksExtension(): MarkedExtension {
  return {
    extensions: [
      {
        name: "infoBlock",
        level: "block",
        start(src: string) {
          return src.match(/^:::/)?.index;
        },
        tokenizer(src: string) {
          const match = src.match(/^:::(\w+)(?:[ \t]+([^\n]+))?\s*\n([\s\S]*?)\n:::/);
          if (!match) return undefined;

          const typeStr = match[1]?.toLowerCase() as BlockType;
          if (!blockConfig[typeStr]) return undefined;

          return {
            type: "infoBlock",
            raw: match[0],
            blockType: typeStr,
            title: match[2]?.trim(),
            content: match[3]?.trim() ?? "",
          };
        },
        renderer(token: Tokens.Generic) {
          const blockType = token.blockType as BlockType;
          const config = blockConfig[blockType];
          const content = escapeHtml(token.content as string);
          const title = escapeHtml((token.title as string | undefined) ?? config.label);
          const renderedContent = renderInlineContent(content);

          return `<aside class="${NOTICE_CARD_CLASSES.root}" data-tone="${config.tone}">
  <div class="${NOTICE_CARD_CLASSES.inner}">
    <i class="${NOTICE_CARD_ICONS[config.tone]} ${NOTICE_CARD_CLASSES.icon}" aria-hidden="true"></i>
    <div class="${NOTICE_CARD_CLASSES.content}">
      <p class="${NOTICE_CARD_CLASSES.title}">${title}</p>
      <div class="${NOTICE_CARD_CLASSES.body}">${renderedContent}</div>
    </div>
  </div>
</aside>`;
        },
      },
    ],
  };
}

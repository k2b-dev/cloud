import {
  applyPanesIntent,
  applyPanesPreset,
  type PanesLayout,
  type PanesNode,
  parsePanesLayout,
  reconcilePanesLayout,
  resizePanesSplit,
} from "@k2b/ui";

export const MAIL_COMPOSER_PANES_COOKIE = "settings-app-mail-composer-panes";

/** In the order the Arrange presets place them: the draft first, then the conversation, then the preview. */
const COMPOSER_PANE_IDS = ["editor", "history", "preview"] as const;

/**
 * F3: the draft on the left; on the right the conversation above the preview. The conversation gets more height
 * because it is read, the preview is only checked. A new message has no conversation: draft beside preview.
 */
export const createDefaultMailComposerPanesLayout = (): PanesLayout =>
  resizePanesSplit(resizePanesSplit(applyPanesPreset("stacked", COMPOSER_PANE_IDS)!, [], 0.54), ["second"], 0.58);

const contains = (node: PanesNode | null, itemId: string): boolean =>
  node !== null && (node.type === "group" ? node.items.includes(itemId) : contains(node.first, itemId) || contains(node.second, itemId));

/**
 * Keeps the person's arrangement and only opens or closes panes. A conversation that comes back takes its default
 * place above the preview, so a layout stored for a new message still opens a reply as arranged.
 */
const reconcile = (layout: PanesLayout, open: readonly string[]): PanesLayout => {
  const reconciled = reconcilePanesLayout(layout, open);
  // Tabs stay tabs: in one group the conversation joins as a tab.
  if (
    contains(layout.root, "history") ||
    !open.includes("history") ||
    !contains(reconciled.root, "preview") ||
    reconciled.root?.type === "group"
  ) {
    return reconciled;
  }
  return applyPanesIntent(reconciled, { type: "split", itemId: "history", targetItemId: "preview", side: "top" });
};

/** The compose page: the preview only for Markdown, the conversation only for a reply. */
export const reconcileMailComposerPanes = (layout: PanesLayout, format: "plain" | "markdown", hasConversation: boolean): PanesLayout =>
  reconcile(layout, ["editor", ...(format === "markdown" ? ["preview"] : []), ...(hasConversation ? ["history"] : [])]);

/** The large composer always shows the preview, as text for a plain message; the conversation only for a reply. */
export const reconcileLargeMailComposerPanes = (layout: PanesLayout, hasConversation: boolean): PanesLayout =>
  reconcile(layout, ["editor", "preview", ...(hasConversation ? ["history"] : [])]);

const nodeAllowed = (node: PanesNode): boolean => {
  if (node.type === "group") {
    return node.items.every((item) => COMPOSER_PANE_IDS.includes(item as (typeof COMPOSER_PANE_IDS)[number]));
  }
  return nodeAllowed(node.first) && nodeAllowed(node.second);
};

const parseMailComposerPanes = (value: unknown): PanesLayout | null => {
  const layout = parsePanesLayout(value);
  return layout?.root && nodeAllowed(layout.root) && contains(layout.root, "editor") ? layout : null;
};

export const normalizeMailComposerPanes = (value: unknown): PanesLayout =>
  parseMailComposerPanes(value) ?? createDefaultMailComposerPanesLayout();

export const readMailComposerPanesFromCookieHeader = (cookieHeader: string | null | undefined): PanesLayout => {
  let layout: PanesLayout | null = null;
  for (const part of (cookieHeader ?? "").split(";")) {
    const trimmed = part.trim();
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0 || trimmed.slice(0, separatorIndex) !== MAIL_COMPOSER_PANES_COOKIE) continue;
    try {
      layout = parseMailComposerPanes(JSON.parse(decodeURIComponent(trimmed.slice(separatorIndex + 1)))) ?? layout;
    } catch {
      // Ignore malformed duplicates and keep the last valid layout.
    }
  }
  return layout ?? createDefaultMailComposerPanesLayout();
};

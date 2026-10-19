import {
  HELP_SHORTCUT_DESCRIPTION_MAX_LENGTH,
  HELP_SHORTCUT_ID_MAX_LENGTH,
  HELP_SHORTCUT_KEYS_MAX_LENGTH,
  HELP_SHORTCUT_TITLE_MAX_LENGTH,
  HELP_START_SHORTCUT_LIMIT,
  type HelpShortcut,
} from "../ssr/layout-help-start";
import type { PanelContextMessage, PanelPageContext } from "./panel-context";

/**
 * The zod-free half of the panel context contract, for code on every page: islands, the provider runtime and the
 * slot markup must not pull the schema into their first load (shell and Mail first-load guards). The zod schema in
 * ./panel-context stays the contract; a parity test keeps the check below at least as strict.
 */
export const PANEL_CONTEXT_PARAM = "cloud_panel_context";

/** Core is the platform's own surface. Every other provider asks once per app. */
export const panelProviderNeedsConsent = (appId: string): boolean => appId !== "core";

/**
 * Only application-owned same-origin paths. The context must already be valid: Layout and the slot controller build
 * it from validated parts. Null also removes a caller-supplied reserved parameter.
 */
export function withPanelContext(href: string, context: PanelPageContext | null): string {
  // The parsed result decides, not the raw text: a query may hold a raw backslash (browsers keep it), while
  // `/\\host` or `/\t/host` resolve to another origin and `/.//host` normalises to a protocol-relative path.
  const base = "https://panel.invalid";
  const url = href.startsWith("/") ? new URL(href, base) : null;
  if (!url || url.origin !== base || url.pathname.startsWith("//")) throw new Error("Expected a same-origin panel path");
  url.searchParams.delete(PANEL_CONTEXT_PARAM);
  if (context) url.searchParams.set(PANEL_CONTEXT_PARAM, JSON.stringify(context));
  return `${url.pathname}${url.search}${url.hash}`;
}

const HELP_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const APP_ID = /^[a-z][a-z0-9-]*$/;
const QUALIFIED_ID = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
// RFC 9562 versions 1 to 8 with the RFC variant; the shell always uses crypto.randomUUID().
const PAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Exact keys, including symbol and non-enumerable ones, like the other panel messages.
const exactKeys = (value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => typeof key === "string" && (required.includes(key) || optional.includes(key)))
  );
};
const text = (value: unknown, min: number, max: number, pattern?: RegExp): value is string =>
  typeof value === "string" && value.length >= min && value.length <= max && (!pattern || pattern.test(value));

export function isPanelPageContext(value: unknown): value is PanelPageContext {
  if (!exactKeys(value, ["v", "seq", "pageId", "app"], ["scope", "help"])) return false;
  const { v, seq, pageId, app, scope, help } = value;
  return (
    v === 1 &&
    typeof seq === "number" &&
    Number.isSafeInteger(seq) &&
    seq >= 0 &&
    text(pageId, 36, 36, PAGE_ID) &&
    text(app, 1, 80, APP_ID) &&
    (scope === undefined || (exactKeys(scope, ["type", "id"]) && text(scope.type, 3, 180, QUALIFIED_ID) && text(scope.id, 1, 512))) &&
    (help === undefined ||
      // Index by index: `every` skips the holes of a sparse array, which the schema rejects.
      (Array.isArray(help) &&
        help.length >= 1 &&
        help.length <= 3 &&
        Array.from({ length: help.length }, (_, index) => index).every((index) => index in help && text(help[index], 0, 180, HELP_ID))))
  );
}

export function isPanelShortcut(value: unknown): value is HelpShortcut {
  return (
    exactKeys(value, ["id", "title", "shortcut"], ["description", "scope"]) &&
    text(value.id, 1, HELP_SHORTCUT_ID_MAX_LENGTH) &&
    text(value.title, 1, HELP_SHORTCUT_TITLE_MAX_LENGTH) &&
    (value.description === undefined || text(value.description, 0, HELP_SHORTCUT_DESCRIPTION_MAX_LENGTH)) &&
    text(value.shortcut, 1, HELP_SHORTCUT_KEYS_MAX_LENGTH) &&
    (value.scope === undefined || value.scope === "selection" || value.scope === "page")
  );
}

export function isPanelContextMessage(value: unknown): value is PanelContextMessage {
  if (!exactKeys(value, ["type", "v", "context"], ["shortcuts"])) return false;
  const { shortcuts } = value;
  return (
    value.type === "cloud.panel.context" &&
    value.v === 1 &&
    (value.context === null || isPanelPageContext(value.context)) &&
    (shortcuts === undefined ||
      (value.context !== null &&
        Array.isArray(shortcuts) &&
        shortcuts.length <= HELP_START_SHORTCUT_LIMIT &&
        Array.from({ length: shortcuts.length }, (_, index) => index).every(
          (index) => index in shortcuts && isPanelShortcut(shortcuts[index]),
        )))
  );
}

import type { Context } from "hono";
import { parseWidgetSettings } from "../_internal/widget-settings";
import {
  type DashboardWidgetSize,
  fitWidgetSize,
  resolveWidgetSizes,
  type WidgetRequest,
  type WidgetSettingsDeclaration,
} from "../contracts/widgets";

/** The query parameter Core uses to ask a widget handler for one size. */
export const WIDGET_SIZE_PARAM = "size";
/** The query parameter Core uses to send one entry's validated settings. */
export const WIDGET_SETTINGS_PARAM = "settings";
/**
 * Bun's default maximum request head is 16 KiB (a 17,000-character query was verified to return 431). The invocation
 * JWT uses up to 4 KiB (IDENTITY_MAX_COMPACT_TOKEN_BYTES), and the path and other forwarded headers use about 1–2 KiB,
 * leaving headroom for 8 KiB of URL-encoded settings. Core measures that encoding and never forwards more. A decoded
 * value is never longer than its encoding, so the app never drops settings Core sends; longer input counts as missing.
 */
export const WIDGET_SETTINGS_PARAM_MAX_LENGTH = 8 * 1024;

const requests = new WeakMap<Request, WidgetRequest>();

/**
 * Records what the dashboard asked a declared widget for, already fitted to the declaration. Only the framework's
 * internal widget route calls this, before it runs the handler.
 */
export const setWidgetRequest = (
  c: Context,
  declaration: { sizes?: readonly DashboardWidgetSize[]; defaultSize?: DashboardWidgetSize; settings?: WidgetSettingsDeclaration },
): WidgetRequest => {
  const param = c.req.query(WIDGET_SETTINGS_PARAM);
  let raw: unknown;
  if (param !== undefined && param.length <= WIDGET_SETTINGS_PARAM_MAX_LENGTH) {
    try {
      raw = JSON.parse(param);
    } catch {
      /* Malformed settings are treated as missing values. */
    }
  }
  const request = {
    size: fitWidgetSize(c.req.query(WIDGET_SIZE_PARAM), resolveWidgetSizes(declaration)),
    settings: parseWidgetSettings(declaration.settings, raw),
  };
  requests.set(c.req.raw, request);
  return request;
};

/**
 * What the dashboard asks this widget handler for. `size` is always one of the sizes the widget declares; return the
 * content that fits it, for example only the one number in `small`. Outside a dashboard invocation, such as a request
 * to the handler's own public route, the request is `{ size: "large", settings: {} }`. Settings are validated against
 * the declaration. The handler must still authorize every chosen resource on every call and work without settings.
 */
export const getWidgetRequest = (c: Context): WidgetRequest => requests.get(c.req.raw) ?? { size: "large", settings: {} };

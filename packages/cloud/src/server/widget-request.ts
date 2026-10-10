import type { Context } from "hono";
import { type DashboardWidgetSize, fitWidgetSize, resolveWidgetSizes, type WidgetRequest } from "../contracts/widgets";

/** The query parameter Core uses to ask a widget handler for one size. */
export const WIDGET_SIZE_PARAM = "size";

const requests = new WeakMap<Request, WidgetRequest>();

/**
 * Records what the dashboard asked a declared widget for, already fitted to the declaration. Only the framework's
 * internal widget route calls this, before it runs the handler.
 */
export const setWidgetRequest = (
  c: Context,
  declaration: { sizes?: readonly DashboardWidgetSize[]; defaultSize?: DashboardWidgetSize },
): WidgetRequest => {
  const request = { size: fitWidgetSize(c.req.query(WIDGET_SIZE_PARAM), resolveWidgetSizes(declaration)) };
  requests.set(c.req.raw, request);
  return request;
};

/**
 * What the dashboard asks this widget handler for. `size` is always one of the sizes the widget declares; return the
 * content that fits it, for example only the one number in `small`. Outside a dashboard invocation, such as a request
 * to the handler's own public route, the request is `large`, the height every widget had before sizes existed.
 */
export const getWidgetRequest = (c: Context): WidgetRequest => requests.get(c.req.raw) ?? { size: "large" };

import { z } from "zod";
import { HELP_VIEW_LIMIT } from "../shared/help";
import {
  CAPABILITY_APP_ID_MAX_LENGTH,
  CAPABILITY_QUALIFIED_ID_MAX_LENGTH,
  CapabilityAppIdSchema,
  CLOUD_RESOURCE_ID_MAX_LENGTH,
  CloudResourceRefSchema,
} from "./capabilities";

export const PANEL_CONTEXT_PARAM = "cloud_panel_context";
/** Local Help document ids, as accepted by Layout.help, bounded for URL transport. */
export const PANEL_HELP_ID_MAX_LENGTH = 180;
export const PanelPageContextSchema = z
  .object({
    v: z.literal(1),
    seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    pageId: z.uuid(),
    app: CapabilityAppIdSchema,
    scope: CloudResourceRefSchema.optional(),
    help: z
      .array(
        z
          .string()
          .max(PANEL_HELP_ID_MAX_LENGTH)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      )
      .min(1)
      .max(HELP_VIEW_LIMIT)
      .optional(),
  })
  .strict();
/** v1 carries only the place and static Help ids. Later fields are additive; never infer authority from a ref. */
export type PanelPageContext = z.infer<typeof PanelPageContextSchema>;
export type PanelConsentSnapshot = { provider: string; allowed: boolean | null };

// 128 chars cover JSON keys/punctuation, version and a 16-digit safe seq; add UUID (36), app (80),
// ref type (180), ref id (512), and three Help ids (180 each + quotes/comma).
// Only ref ids allow JSON escapes: each UTF-16 unit can expand to six characters (\uXXXX).
export const PANEL_CONTEXT_PARAM_MAX_LENGTH =
  128 +
  36 +
  CAPABILITY_APP_ID_MAX_LENGTH +
  CAPABILITY_QUALIFIED_ID_MAX_LENGTH +
  6 * CLOUD_RESOURCE_ID_MAX_LENGTH +
  HELP_VIEW_LIMIT * (PANEL_HELP_ID_MAX_LENGTH + 3);

export const encodePanelContextParam = (context: PanelPageContext): string => JSON.stringify(PanelPageContextSchema.parse(context));

export function parsePanelContextParam(value: string | null | undefined): PanelPageContext | null {
  if (!value || value.length > PANEL_CONTEXT_PARAM_MAX_LENGTH) return null;
  try {
    const parsed = PanelPageContextSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Only application-owned same-origin paths. Null also removes a caller-supplied reserved parameter. */
export function withPanelContext(href: string, context: PanelPageContext | null): string {
  if (!href.startsWith("/") || href.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(href))
    throw new Error("Expected a same-origin panel path");
  const url = new URL(href, "https://panel.invalid");
  url.searchParams.delete(PANEL_CONTEXT_PARAM);
  if (context) url.searchParams.set(PANEL_CONTEXT_PARAM, encodePanelContextParam(context));
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Core is the platform's own surface. Every other provider asks once per app. */
export const panelProviderNeedsConsent = (appId: string): boolean => appId !== "core";

export const PanelContextMessageSchema = z
  .object({ type: z.literal("cloud.panel.context"), v: z.literal(1), context: PanelPageContextSchema.nullable() })
  .strict();
export type PanelContextMessage = z.infer<typeof PanelContextMessageSchema>;
export function isPanelContextMessage(value: unknown): value is PanelContextMessage {
  // Match the exact-key message contracts, including symbol/non-enumerable keys.
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 3 ||
    !Object.hasOwn(value, "type") ||
    !Object.hasOwn(value, "v") ||
    !Object.hasOwn(value, "context")
  )
    return false;
  return PanelContextMessageSchema.safeParse(value).success;
}

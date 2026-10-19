import { z } from "zod";

export {
  isPanelContextMessage,
  isPanelPageContext,
  PANEL_CONTEXT_PARAM,
  panelProviderNeedsConsent,
  withPanelContext,
} from "./panel-context-plain";

import { HELP_VIEW_LIMIT } from "../shared/help";
import {
  CAPABILITY_APP_ID_MAX_LENGTH,
  CAPABILITY_QUALIFIED_ID_MAX_LENGTH,
  CapabilityAppIdSchema,
  CLOUD_RESOURCE_ID_MAX_LENGTH,
  CloudResourceRefSchema,
} from "./capabilities";

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
export type PanelConsentSnapshot = { provider: string; allowed: boolean | null; revision: number };

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

export const PanelContextMessageSchema = z
  .object({ type: z.literal("cloud.panel.context"), v: z.literal(1), context: PanelPageContextSchema.nullable() })
  .strict();
export type PanelContextMessage = z.infer<typeof PanelContextMessageSchema>;

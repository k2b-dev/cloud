import { z } from "zod";
import type { AppAppearance } from "../contracts/app";

const appearanceSchema = z.object({
  primary: z.literal("ai", { error: 'appearance.primary must be "ai" or omitted (blue)' }).optional(),
});

/** Validate declaration input before it reaches SSR or registry metadata. */
export const validateAppAppearance = (appId: string, appearance: AppAppearance | undefined): void => {
  if (appearance === undefined) return;
  const result = appearanceSchema.safeParse(appearance);
  if (!result.success)
    throw new Error(`App "${appId}" declares invalid appearance: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
};

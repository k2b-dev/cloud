import { z } from "zod";

/** One page swap that loaded the document instead: the app and the stable reason, never the URL or the person. */
export const PAGE_SWAP_FALLBACK_MAX_BYTES = 512;
export const PageSwapFallbackReportSchema = z
  .object({
    appId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/),
    reason: z.enum([
      "network",
      "timeout",
      "status",
      "content-type",
      "redirect",
      "shell",
      "assets",
      "head",
      "module",
      "commit",
      "history",
      "history-limit",
      "error",
    ]),
    status: z.number().int().min(100).max(599).optional(),
  })
  .strict();
export type PageSwapFallbackReport = z.infer<typeof PageSwapFallbackReportSchema>;

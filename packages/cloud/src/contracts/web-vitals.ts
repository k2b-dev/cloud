import { z } from "zod";

/** One metric plus six server phases and bounded routing metadata. */
export const WEB_VITALS_MAX_BYTES = 4096;
export const WebVitalsReportSchema = z
  .object({
    appId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/),
    routeTemplate: z
      .string()
      .min(1)
      .max(200)
      .regex(/^\/[a-zA-Z0-9_/:.*-]*$/),
    id: z.string().min(1).max(100),
    name: z.enum(["LCP", "INP", "CLS"]),
    value: z.number().nonnegative(),
    navigationType: z.string().max(32),
    serverTiming: z.partialRecord(
      z.enum(["auth", "settings", "runtime", "ssr_data", "ssr_finalize", "ssr_render"]),
      z.number().nonnegative(),
    ),
  })
  .strict();
export type WebVitalsReport = z.infer<typeof WebVitalsReportSchema>;

import { z } from "zod";

export const RunnerMetadata = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  sourceRevision: z.number().int().positive(),
  publishedVersion: z.number().int().positive(),
  serverAccess: z.boolean(),
  canManage: z.boolean(),
  /** The app has an index.html interface; apps without one only offer actions. */
  hasInterface: z.boolean(),
});
export type RunnerMetadata = z.infer<typeof RunnerMetadata>;
export const ViewerContext = z.object({
  locale: z.string(),
  timeZone: z.string(),
  user: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export const RunnerApp = z.object({
  metadata: RunnerMetadata,
  files: z.array(z.object({ path: z.string(), content: z.string() })),
  context: ViewerContext,
});
export const runnerHref = (id: string) => `/app/assistant/apps/${encodeURIComponent(id)}/run`;

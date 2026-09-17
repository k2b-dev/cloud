import { z } from "zod";

export const RunnerMetadata = z.object({
  id: z.string(), title: z.string(), description: z.string().optional(), icon: z.string().optional(),
  sourceRevision: z.number().int().positive(), publishedVersion: z.number().int().positive(),
  serverAccess: z.boolean(), canManage: z.boolean(),
});
export type RunnerMetadata = z.infer<typeof RunnerMetadata>;
export const RunnerCompiled = z.object({ metadata: RunnerMetadata, code: z.string(), runtime: z.string() });
export const runnerHref = (id: string) => `/app/assistant/apps/${encodeURIComponent(id)}/run`;

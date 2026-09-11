import { z } from "zod";
import { LIMITS } from "./contracts";
export const QueryId = z.uuid();
export const QueryInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    sql: z.string().trim().min(1).max(LIMITS.text),
  })
  .strict();
export const QueryUpdate = QueryInput.extend({ revision: z.number().int().positive() });
export const QueryRevision = z.object({ revision: z.number().int().positive() }).strict();
export const QueryPage = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), name: QueryInput.shape.name.optional() });
export type SavedQuery = z.infer<typeof QueryInput> & { id: string; revision: number; updatedAt: string };
export type QuerySummary = Omit<SavedQuery, "sql">;

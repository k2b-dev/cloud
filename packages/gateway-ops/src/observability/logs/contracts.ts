import { z } from "zod";

export const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);

export const LogEntrySchema = z.object({
  id: z.string(),
  level: LogLevelSchema,
  source: z.string(),
  message: z.string(),
  metadata: z.record(z.string(), z.any()).nullable(),
  createdAt: z.string(),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

export {
  createPagination,
  ErrorResponseSchema,
  PaginationQuerySchema,
  PaginationResponseSchema,
  parsePagination,
} from "@k2b/cloud/contracts";

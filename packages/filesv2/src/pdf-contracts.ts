import { z } from "zod";
import type { EntryResult } from "./contracts";

const fields = {
  paths: z.array(z.string().min(1).max(4096)).min(1),
  name: z
    .string()
    .min(1)
    .max(255)
    .regex(/\.pdf$/i),
};
export const PdfInputSchema = z.discriminatedUnion("operation", [
  z.object({ ...fields, operation: z.literal("merge"), paths: fields.paths.min(2) }).strict(),
  z.object({ ...fields, operation: z.literal("extract"), pages: z.array(z.number().int().positive().safe()).min(1) }).strict(),
]);
export type PdfInput = z.infer<typeof PdfInputSchema>;
export type PdfEvent =
  | { type: "progress"; done: number; total: number }
  | { type: "done"; result: EntryResult }
  | { type: "error"; code: string; message: string; path?: string };

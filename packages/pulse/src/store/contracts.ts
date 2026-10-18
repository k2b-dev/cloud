import { z } from "zod";
import { CHECK_STEPS, REQUIRED_RIGHTS, type StoreCheckCode } from "./check-codes";

const isCheckCode = (value: unknown): value is StoreCheckCode =>
  typeof value === "string" &&
  (["UNREACHABLE", "AUTH_FAILED", "VERSION_TOO_OLD", "TOO_MANY_RIGHTS"].includes(value) ||
    REQUIRED_RIGHTS.some((right) => value === `MISSING_RIGHT:${right}`) ||
    /^PROFILE_MISSING:[a-z][a-z0-9_]*_(?:read_small|read_normal|read_large|maintenance)$/.test(value));
const step = z.enum(["ok", "failed", "skipped"]);
export const StoreCheckSchema = z.object({
  ok: z.boolean(),
  code: z.custom<StoreCheckCode>(isCheckCode).optional(),
  version: z
    .string()
    .regex(/^\d+\.\d+(?:\.\d+)*$/)
    .optional(),
  latencyMs: z.number().nonnegative().optional(),
  checkedAt: z.string(),
  steps: z.record(z.enum(CHECK_STEPS), step),
});
export const StoreStatusSchema = z.object({
  configured: z.boolean(),
  url: z.string(),
  user: z.string(),
  passwordSet: z.boolean(),
  status: StoreCheckSchema.nullable(),
});
export type StoreConfig = { configured: boolean; url: string; user: string; passwordSet: boolean };
export type StoreStatus = z.infer<typeof StoreStatusSchema>;

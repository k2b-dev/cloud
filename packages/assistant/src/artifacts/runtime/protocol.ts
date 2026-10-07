import { z } from "zod";
import { LIMITS } from "../contracts";

/** Messages a script worker sends to its host through the sandbox frame. */
export const WorkerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cancel"), id: z.number().int().nonnegative() }),
  z.object({
    type: z.literal("work"),
    status: z.enum(["running", "completed", "cancelled", "error"]),
    completed: z.number().nonnegative(),
    total: z.number().nonnegative().optional(),
    label: z.string().max(1000).optional(),
  }),
  z.object({
    type: z.literal("log"),
    level: z.enum(["log", "info", "warn", "error"]),
    text: z.string().max(LIMITS.text),
  }),
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("output"), value: z.json() }),
  z.object({ type: z.literal("error"), text: z.string().max(LIMITS.text) }),
  z.object({
    type: z.literal("rpc"),
    id: z.number().int().nonnegative(),
    method: z.enum([
      "file.read",
      "file.save",
      "capabilities.run",
      "capabilities.stream",
      "http.fetch",
      "pdf",
      "ai",
      "database",
      "storage",
      "runtime.chunk",
    ]),
    args: z.array(z.unknown()).max(4),
  }),
]);

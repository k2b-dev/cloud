import { z } from "zod";
import { AnalyticsNode, AnalyticsEvent } from "./analytics-contracts";
import { LIMITS } from "../contracts";
export const FileOpenOptions = z.object({ accept: z.string().max(LIMITS.text).optional() }).strict();
export const UiNode = AnalyticsNode;
export type UiNode = z.infer<typeof UiNode>;
export const WorkerMessage = z.discriminatedUnion("type", [
  z.object({type:z.literal("work"),status:z.enum(["running","completed","cancelled","error"]),completed:z.number().nonnegative(),total:z.number().nonnegative().optional(),label:z.string().max(1000).optional()}),
  z.object({ type: z.literal("ui"), nodes: z.array(UiNode).max(LIMITS.nodes) }),
  z.object({
    type: z.literal("log"),
    level: z.enum(["log", "info", "warn", "error"]),
    text: z.string().max(LIMITS.text),
  }),
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("output"), value: z.json() }),
  z.object({ type: z.literal("settled"), id: z.number().int().nonnegative(), error: z.string().max(LIMITS.text).optional() }),
  z.object({ type: z.literal("busy"), value: z.boolean() }),
  z.object({ type: z.literal("error"), text: z.string().max(LIMITS.text) }),
  z.object({
    type: z.literal("rpc"),
    id: z.number().int().nonnegative(),
    method: z.enum([
      "ui.modal",
      "file.list",
      "file.read",
      "file.open",
      "file.openMultiple",
      "file.openFolder",
      "file.save",
      "capabilities.run",
      "http.fetch",
      "database",
      "storage",
      "store.get",
      "store.set",
      "store.delete",
      "store.keys",
      "opfs.read",
      "opfs.write",
      "opfs.delete",
      "opfs.list",
    ]),
    args: z.array(z.unknown()).max(4),
  }),
]);

export const RuntimeEvent = z.object({
  id: z.string().min(1).max(80),
  event: AnalyticsEvent.optional(),
}).strict();
export type RuntimeEvent = z.infer<typeof RuntimeEvent>;

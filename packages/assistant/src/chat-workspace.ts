import { type PanesLayout, type PanesNode, parsePanesLayout } from "@k2b/ui";
import { z } from "zod";
import { isWebAddress } from "./web-address";

export const ChatWorkspaceTabSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[A-Za-z0-9_:.-]+$/),
  key: z
    .string()
    .min(1)
    .max(600)
    .refine((key) => {
      // Other tab kinds stay opaque; web addresses have one rule at creation, storage and restore.
      try {
        const parts: unknown = JSON.parse(key);
        return (
          !Array.isArray(parts) || parts[0] !== "web" || (parts.length === 3 && typeof parts[2] === "string" && isWebAddress(parts[2]))
        );
      } catch {
        return true;
      }
    }, "Web tabs require an HTTP or HTTPS address without credentials"),
  title: z.string().max(200),
  pinned: z.boolean().optional(),
});
export type ChatWorkspaceTab = z.infer<typeof ChatWorkspaceTabSchema>;

const LayoutSchema = z.unknown().transform((value, ctx): PanesLayout | null => {
  if (value === null) return null;
  const layout = parsePanesLayout(value);
  if (layout) return layout;
  ctx.addIssue({ code: "custom", message: "Invalid Panes layout" });
  return z.NEVER;
});

export const ChatWorkspaceStateSchema = z
  .object({
    tabs: z.array(ChatWorkspaceTabSchema).max(24),
    layout: LayoutSchema,
    front: z.string().nullable(),
  })
  .superRefine((state, ctx) => {
    const ids = new Set(state.tabs.map((tab) => tab.id));
    const keys = new Set(state.tabs.map((tab) => tab.key));
    if (ids.size !== state.tabs.length || keys.size !== state.tabs.length)
      ctx.addIssue({ code: "custom", path: ["tabs"], message: "Tab ids and keys must be unique" });
    if (state.front !== null && !ids.has(state.front))
      ctx.addIssue({ code: "custom", path: ["front"], message: "Front must be an open tab id" });
    if (state.layout !== null) {
      const items: string[] = [];
      const visit = (node: PanesNode | null): void => {
        if (!node) return;
        if (node.type === "group") items.push(...node.items);
        else {
          visit(node.first);
          visit(node.second);
        }
      };
      visit(state.layout.root);
      if (items.length !== ids.size || items.some((id) => !ids.has(id)))
        ctx.addIssue({ code: "custom", path: ["layout"], message: "Layout must contain every open tab id and no other ids" });
    }
    if (new TextEncoder().encode(JSON.stringify(state)).byteLength > 32 * 1024)
      ctx.addIssue({ code: "custom", message: "Workspace state must not exceed 32 KiB" });
  });
export type ChatWorkspaceState = z.infer<typeof ChatWorkspaceStateSchema>;

export const SaveChatWorkspaceSchema = z.object({
  state: ChatWorkspaceStateSchema,
  revision: z.number().int().nonnegative(),
});
export type SaveChatWorkspaceInput = z.infer<typeof SaveChatWorkspaceSchema>;
export type ChatWorkspaceSnapshot = { state: ChatWorkspaceState; revision: number };
export type SaveChatWorkspaceResult = { conflict: false; revision: number } | ({ conflict: true } & ChatWorkspaceSnapshot);

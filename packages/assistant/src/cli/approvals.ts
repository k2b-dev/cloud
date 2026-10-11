import type { AiApprovalPreferenceView } from "@k2b/cloud/ai";
import { arg, type CloudCliContext, command, flag } from "@k2b/cloud/cli";
import { printRows, printValue, queryString, readApi } from "./shared";

export const readApprovalPreferences = (
  ctx: CloudCliContext,
  conversationId?: string,
): Promise<{ approvals: AiApprovalPreferenceView[] }> =>
  readApi(ctx, `/approval-preferences${queryString({ conversation: conversationId })}`);

export const revokeApprovalPreference = (ctx: CloudCliContext, id: string): Promise<unknown> =>
  readApi(ctx, `/approval-preferences/${encodeURIComponent(id)}`, { method: "DELETE" });

export const assistantApprovalCommands = [
  command("approvals list", {
    summary: "List remembered Cloud approvals",
    flags: { chat: flag.string({ description: "List approvals limited to this chat ID" }) },
    async run({ ctx, flags }) {
      const result = await readApprovalPreferences(ctx, flags.chat);
      printRows(
        ctx,
        result,
        result.approvals.map((approval) => ({
          id: approval.id,
          title: approval.title,
          app: approval.website ? "Website" : (approval.app?.name ?? "Cloud AI tool"),
          scope: approval.conversationId ? "chat" : "everywhere",
          lastUsed: approval.lastUsedAt ?? "",
        })),
        [{ key: "id" }, { key: "title" }, { key: "app" }, { key: "scope" }, { key: "lastUsed" }],
      );
    },
  }),
  command("approvals revoke", {
    summary: "Revoke a remembered Cloud approval",
    args: { approval: arg.required({ valueLabel: "approval-id" }) },
    async run({ ctx, args }) {
      const result = await revokeApprovalPreference(ctx, args.approval);
      printValue(ctx, result, `Revoked ${args.approval}.`);
    },
  }),
] as const;

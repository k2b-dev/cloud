import { prompts, toast } from "@k2b/ui";
import { apiClient } from "../../../api/client";
import type { MailboxController } from "../../mail-workspace";
import { readApiError } from "../api-response";
import { mailConversationUiMessages } from "../mail-conversation-ui-messages";

/**
 * "Bearbeiten" at the short summary of the v2 reader: the same form, request and update as v1's summary card, so a
 * person's text replaces the summary and the conversation's revision follows.
 */
export const editMailV2Summary = async (controller: MailboxController, locale: string): Promise<void> => {
  const { t } = mailConversationUiMessages.resolve([locale]);
  const data = controller.data;
  const conversationId = data.selectedConversationId;
  const current = data.conversationSummary;
  if (!conversationId || !current) return;
  const values = await prompts.form({
    title: current.summary ? t.editSummary : t.createSummary,
    icon: "ti ti-notes",
    size: "large",
    fields: {
      summary: {
        type: "text",
        label: t.summary,
        description: t.summaryDescription,
        default: current.summary ?? "",
        multiline: true,
        lines: 8,
        maxLength: 50_000,
        markdown: true,
      },
    },
    confirmText: current.summary ? t.saveSummary : t.createSummary,
  });
  // Another conversation opened while the form was open: its summary is not this one.
  if (!values || controller.data.selectedConversationId !== conversationId) return;
  const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].summary.$put({
    param: { mailboxId: data.mailbox.id, conversationId },
    json: { expectedSummaryRevision: current.summaryRevision, summary: String(values.summary ?? "") },
  });
  if (!response.ok) {
    toast.error(await readApiError(response, t.updateSummaryFailed));
    return;
  }
  await controller.applySavedConversationSummary(conversationId, await response.json());
};

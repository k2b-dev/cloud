import { IconButton, MarkdownView, Paper, Tooltip, useLocale } from "@k2b/ui";
import { createMemo, Show } from "solid-js";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";

export default function MailConversationSummaryCard(props: {
  summary: string;
  canEdit: boolean;
  editDisabled?: boolean;
  onEdit: () => void;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
  return (
    <Paper
      as="section"
      class="relative mx-auto my-3 w-full max-w-4xl overflow-hidden p-4 pl-5"
      aria-labelledby="mail-conversation-summary-title"
      data-mail-conversation-summary
    >
      <div class="mb-2 flex items-center gap-2">
        <h2 id="mail-conversation-summary-title" class="min-w-0 flex-1 text-sm font-semibold text-[var(--app-accent)]">
          {t().conversationSummary}
        </h2>
        <Show when={props.canEdit}>
          <Tooltip.Anchor content={t().editSummary}>
            <IconButton
              type="button"
              size="sm"
              variant="ghost"
              label={t().editSummary}
              disabled={props.editDisabled}
              onClick={props.onEdit}
            >
              <i class="ti ti-pencil" aria-hidden="true" />
            </IconButton>
          </Tooltip.Anchor>
        </Show>
      </div>
      <div data-mail-conversation-summary-body>
        <MarkdownView markdown={props.summary} headingScale="compact" class="text-sm text-primary" />
      </div>
    </Paper>
  );
}

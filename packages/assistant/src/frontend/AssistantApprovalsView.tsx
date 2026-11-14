import { Approvals } from "@k2b/cloud/approvals/ui";
import type { ApprovalPage } from "@k2b/cloud/contracts/approvals";
import { ScrollArea, useLocale } from "@k2b/ui";
import AssistantCodeAttention, { type CodeAttentionView } from "./AssistantCodeAttention";
import { assistantMessages } from "./messages";
import { useAssistantText } from "./ui-copy";

/**
 * Waiting for you: what Gustav asked for in chats, whichever app owns the effect, each row linking to its chat; below,
 * Code of a place the person administers when it needs them.
 */
export default function AssistantApprovalsView(props: { initial?: ApprovalPage; initialAttention?: CodeAttentionView | null }) {
  const text = useAssistantText();
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  return (
    <ScrollArea class="min-h-0 flex-1 p-[var(--ui-space-section)]">
      <div class="mx-auto flex w-full max-w-3xl flex-col gap-6 pb-8">
        <header class="flex min-w-0 flex-col gap-1">
          <h1 class="text-xl font-semibold text-primary">{t().waitingForYou}</h1>
          <p class="text-sm text-secondary">
            {text("What Gustav wants to do for you. Nothing of it happens until you approve it here or in its chat.")}
          </p>
        </header>
        <section class="flex flex-col gap-2" aria-labelledby="assistant-approvals-chats">
          <h2 id="assistant-approvals-chats" class="assistant-code-attention__heading">
            {t().codeFromChats}
          </h2>
          <Approvals app="assistant" initial={props.initial} />
        </section>
        <AssistantCodeAttention initial={props.initialAttention} />
      </div>
    </ScrollArea>
  );
}

import { Approvals } from "@k2b/cloud/approvals/ui";
import type { ApprovalPage } from "@k2b/cloud/contracts/approvals";
import { ScrollArea, useLocale } from "@k2b/ui";
import { assistantMessages } from "./messages";
import { useAssistantText } from "./ui-copy";

/** Everything the Assistant asked for, whichever app owns the effect. Each row links to the chat that waits for it. */
export default function AssistantApprovalsView(props: { initial?: ApprovalPage }) {
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
        <Approvals app="assistant" initial={props.initial} />
      </div>
    </ScrollArea>
  );
}

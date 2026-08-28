import { ButtonLink, StatCell, StatGrid, useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";
import type { MailAutomationActivityData } from "../service/automation-workspace";
import MailAutomationActivityTable from "./_components/MailAutomationActivityTable";
import MailAutomationShell from "./_components/MailAutomationShell";
import { mailAutomationPageMessages } from "./mail-automation-page-messages";

export default function MailAutomationActivityPage(props: { data: MailAutomationActivityData; currentUserEmail: string | null }) {
  const locale = useLocale();
  const messages = createMemo(() => mailAutomationPageMessages.resolve([locale()]).t);
  return (
    <MailAutomationShell
      mailbox={props.data.mailbox}
      permission={props.data.permission}
      currentUserEmail={props.currentUserEmail}
      activePage="activity"
    >
      <div class="flex flex-wrap items-start justify-between gap-3">
        <header>
          <h1 class="text-base font-semibold text-primary">{messages().activity}</h1>
          <p class="mt-0.5 text-xs text-dimmed">{messages().activityDescription}</p>
        </header>
        <ButtonLink variant="secondary" size="sm" href={`/app/mail/${props.data.mailbox.id}/automations/activity`}>
          <i class="ti ti-refresh" aria-hidden="true" /> {messages().refresh}
        </ButtonLink>
      </div>
      <StatGrid columns={4}>
        <StatCell
          label={messages().recentActivity}
          value={props.data.counts.total}
          sub={messages().upToEntries({ count: 200 })}
          accent={{ tone: "blue", icon: "ti ti-activity" }}
        />
        <StatCell
          label={messages().inProgress}
          value={props.data.counts.active}
          sub={messages().inProgressDescription}
          accent={{ tone: "blue", icon: "ti ti-loader-2" }}
        />
        <StatCell
          label={messages().needsAttention}
          value={props.data.counts.failed}
          sub={messages().needsAttentionDescription}
          accent={{
            tone: props.data.counts.failed > 0 ? "red" : "emerald",
            icon: props.data.counts.failed > 0 ? "ti ti-alert-triangle" : "ti ti-check",
          }}
        />
        <StatCell
          label={messages().backfills}
          value={props.data.counts.backfills}
          sub={messages().backfillsDescription}
          accent={{ tone: "zinc", icon: "ti ti-database-import" }}
        />
      </StatGrid>
      <section class="paper overflow-hidden">
        <MailAutomationActivityTable items={props.data.items} />
      </section>
    </MailAutomationShell>
  );
}

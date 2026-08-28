import { ButtonLink, StatCell, StatGrid, useLocale } from "@k2b/ui";
import { createMemo, Show } from "solid-js";
import type { MailAutomationOverviewData } from "../service/automation-workspace";
import MailAutomationActivityTable from "./_components/MailAutomationActivityTable";
import MailAutomationShell from "./_components/MailAutomationShell";
import { mailAutomationPageMessages } from "./mail-automation-page-messages";

export default function MailAutomationOverview(props: { data: MailAutomationOverviewData; currentUserEmail: string | null }) {
  const locale = useLocale();
  const messages = createMemo(() => mailAutomationPageMessages.resolve([locale()]).t);
  const activeReply = () => props.data.automaticReplies.find((configuration) => configuration.enabled) ?? null;
  const activeIncomingAutomations = () => props.data.incomingAutomations?.filter((automation) => automation.enabled).length ?? 0;
  const activeWorkflows = () => props.data.customWorkflows?.filter((workflow) => workflow.activeVersionId).length ?? 0;
  const failures = () =>
    props.data.recentActivity?.filter((item) => item.status === "failed" || item.status === "needs_attention").length ?? 0;
  const base = `/app/mail/${props.data.mailbox.id}/automations`;

  return (
    <MailAutomationShell
      mailbox={props.data.mailbox}
      permission={props.data.permission}
      currentUserEmail={props.currentUserEmail}
      activePage="overview"
    >
      <header>
        <h1 class="text-base font-semibold text-primary">{messages().automations}</h1>
        <p class="mt-0.5 text-xs text-dimmed">{messages().automationsDescription}</p>
      </header>

      <StatGrid columns={props.data.permission === "admin" ? 4 : 1}>
        <StatCell
          label={messages().automaticReply}
          value={activeReply()?.name ?? messages().off}
          sub={activeReply() ? messages().activeNow : messages().noActiveReply}
          href={`${base}/replies`}
          accent={{ tone: activeReply() ? "emerald" : "zinc", icon: activeReply() ? "ti ti-message-check" : "ti ti-message-off" }}
        />
        <Show when={props.data.permission === "admin"}>
          <StatCell
            label={messages().incomingMail}
            value={activeIncomingAutomations()}
            sub={messages().configured({ count: props.data.incomingAutomations?.length ?? 0 })}
            href={`${base}/incoming`}
            accent={{ tone: "blue", icon: "ti ti-inbox-cog" }}
          />
          <StatCell
            label={messages().customWorkflows}
            value={activeWorkflows()}
            sub={messages().configured({ count: props.data.customWorkflows?.length ?? 0 })}
            href={`${base}/workflows`}
            accent={{ tone: "blue", icon: "ti ti-route" }}
          />
          <StatCell
            label={messages().needsAttention}
            value={failures()}
            sub={messages().recentFailedRuns}
            href={`${base}/activity`}
            accent={{ tone: failures() > 0 ? "red" : "emerald", icon: failures() > 0 ? "ti ti-alert-triangle" : "ti ti-check" }}
          />
        </Show>
      </StatGrid>

      <section>
        <div class="mb-2">
          <h2 class="text-sm font-semibold text-primary">{messages().startWithTask}</h2>
          <p class="mt-0.5 text-xs text-dimmed">{messages().taskDescription}</p>
        </div>
        <div class="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          <a class="paper flex min-h-32 items-start gap-3 p-4" href={`${base}/replies?new=out-of-office`}>
            <span class="thumbnail flex h-10 w-10 shrink-0 items-center justify-center">
              <i class="ti ti-beach" aria-hidden="true" />
            </span>
            <span>
              <span class="block text-sm font-semibold text-primary">{messages().outOfOffice}</span>
              <span class="mt-1 block text-xs leading-relaxed text-dimmed">{messages().outOfOfficeDescription}</span>
            </span>
          </a>
          <a class="paper flex min-h-32 items-start gap-3 p-4" href={`${base}/replies?new=office-hours`}>
            <span class="thumbnail flex h-10 w-10 shrink-0 items-center justify-center">
              <i class="ti ti-clock-check" aria-hidden="true" />
            </span>
            <span>
              <span class="block text-sm font-semibold text-primary">{messages().officeHoursAcknowledgement}</span>
              <span class="mt-1 block text-xs leading-relaxed text-dimmed">{messages().officeHoursAcknowledgementDescription}</span>
            </span>
          </a>
          <a class="paper flex min-h-32 items-start gap-3 p-4" href={`${base}/replies?new=reference-acknowledgement`}>
            <span class="thumbnail flex h-10 w-10 shrink-0 items-center justify-center">
              <i class="ti ti-hash" aria-hidden="true" />
            </span>
            <span>
              <span class="block text-sm font-semibold text-primary">{messages().referenceAcknowledgement}</span>
              <span class="mt-1 block text-xs leading-relaxed text-dimmed">{messages().referenceAcknowledgementDescription}</span>
            </span>
          </a>
          <Show when={props.data.permission === "admin"}>
            <a class="paper flex min-h-32 items-start gap-3 p-4" href={`${base}/incoming?new=blank`}>
              <span class="thumbnail flex h-10 w-10 shrink-0 items-center justify-center">
                <i class="ti ti-filter-plus" aria-hidden="true" />
              </span>
              <span>
                <span class="block text-sm font-semibold text-primary">{messages().createIncomingAutomation}</span>
                <span class="mt-1 block text-xs leading-relaxed text-dimmed">{messages().createIncomingAutomationDescription}</span>
              </span>
            </a>
            <a class="paper flex min-h-32 items-start gap-3 p-4" href={`${base}/incoming?new=ai-route`}>
              <span class="thumbnail flex h-10 w-10 shrink-0 items-center justify-center">
                <i class="ti ti-route-alt-left" aria-hidden="true" />
              </span>
              <span>
                <span class="block text-sm font-semibold text-primary">{messages().sortIncomingMail}</span>
                <span class="mt-1 block text-xs leading-relaxed text-dimmed">{messages().sortIncomingMailDescription}</span>
              </span>
            </a>
            <a class="paper flex min-h-32 items-start gap-3 p-4" href={`${base}/incoming?new=ai-tag`}>
              <span class="thumbnail flex h-10 w-10 shrink-0 items-center justify-center">
                <i class="ti ti-tags" aria-hidden="true" />
              </span>
              <span>
                <span class="block text-sm font-semibold text-primary">{messages().addRelevantTags}</span>
                <span class="mt-1 block text-xs leading-relaxed text-dimmed">{messages().addRelevantTagsDescription}</span>
              </span>
            </a>
            <a class="paper flex min-h-32 items-start gap-3 p-4" href={`${base}/incoming?new=ai-draft`}>
              <span class="thumbnail flex h-10 w-10 shrink-0 items-center justify-center">
                <i class="ti ti-pencil-bolt" aria-hidden="true" />
              </span>
              <span>
                <span class="block text-sm font-semibold text-primary">{messages().draftReplies}</span>
                <span class="mt-1 block text-xs leading-relaxed text-dimmed">{messages().draftRepliesDescription}</span>
              </span>
            </a>
            <a class="paper flex min-h-32 items-start gap-3 p-4" href={`${base}/workflows?new=1`}>
              <span class="thumbnail flex h-10 w-10 shrink-0 items-center justify-center">
                <i class="ti ti-code-plus" aria-hidden="true" />
              </span>
              <span>
                <span class="block text-sm font-semibold text-primary">{messages().buildCustomWorkflow}</span>
                <span class="mt-1 block text-xs leading-relaxed text-dimmed">{messages().buildCustomWorkflowDescription}</span>
              </span>
            </a>
          </Show>
        </div>
      </section>

      <Show when={props.data.recentActivity}>
        {(items) => (
          <section class="paper overflow-hidden">
            <div class="flex items-start justify-between gap-3 px-3 py-3">
              <div>
                <h2 class="text-sm font-semibold text-primary">{messages().recentActivity}</h2>
                <p class="mt-0.5 text-xs text-dimmed">{messages().recentActivityDescription}</p>
              </div>
              <ButtonLink variant="ghost" size="sm" href={`${base}/activity`}>
                {messages().viewAll} <i class="ti ti-arrow-right" aria-hidden="true" />
              </ButtonLink>
            </div>
            <MailAutomationActivityTable items={items()} compact />
          </section>
        )}
      </Show>
    </MailAutomationShell>
  );
}

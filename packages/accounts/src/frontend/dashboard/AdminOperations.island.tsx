import { Paper } from "@k2b/ui";
// Platform lifecycle backfill endpoints are owned by cloud-lib (not by an app),
// so the typed client is a cloud-lib export and is identical regardless of
// which container loads it.

import { navigateTo } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, ButtonLink, prompts } from "@k2b/ui";
import { coreClient } from "@valentinkolb/cloud/clients/core";
import { useAccountsMessages } from "../messages";

type JobKind = "ipa-backfill" | "local-user-backfill" | "guest-backfill";
type OperationKey = "ipa-backfill" | "local-user-backfill" | "local-guest-backfill";

const JOB_KIND_BY_OPERATION: Record<OperationKey, JobKind> = {
  "ipa-backfill": "ipa-backfill",
  "local-user-backfill": "local-user-backfill",
  "local-guest-backfill": "guest-backfill",
};

type OperationConfig = {
  key: OperationKey;
  label: string;
  icon: string;
  redirectTo: string;
  confirmText: string;
  loadingText: string;
  successText: string;
  description: string;
};

const SCHEDULED_JOBS_HREF = "/admin/observability/jobs?search=auth%3A";

export default function AdminOperations(props: { freeIpaEnabled: boolean }) {
  const messages = useAccountsMessages();
  const operations = (): readonly OperationConfig[] => [
    {
      key: "ipa-backfill",
      label: messages().forceIpaBackfill,
      icon: "ti ti-user-exclamation",
      redirectTo: "/admin/observability/logs?source=auth:ipa:backfill",
      confirmText: messages().startIpaBackfill,
      loadingText: messages().startingIpaBackfill,
      successText: messages().ipaBackfillStarted,
      description: messages().ipaBackfillDescription,
    },
    {
      key: "local-user-backfill",
      label: messages().forceLocalUserBackfill,
      icon: "ti ti-user-exclamation",
      redirectTo: "/admin/observability/logs?source=auth:local-user:backfill",
      confirmText: messages().startLocalUserBackfill,
      loadingText: messages().startingLocalUserBackfill,
      successText: messages().localUserBackfillStarted,
      description: messages().localUserBackfillDescription,
    },
    {
      key: "local-guest-backfill",
      label: messages().forceLocalGuestBackfill,
      icon: "ti ti-user-exclamation",
      redirectTo: "/admin/observability/logs?source=auth:guest:backfill",
      confirmText: messages().startLocalGuestBackfill,
      loadingText: messages().startingLocalGuestBackfill,
      successText: messages().localGuestBackfillStarted,
      description: messages().localGuestBackfillDescription,
    },
  ];
  let activeOperationKey: OperationKey | null = null;
  const runMutation = mutations.create<{ message?: string; jobId?: string }, OperationConfig>({
    mutation: async (operation) => {
      const response = await coreClient.admin.lifecycle.jobs.$post({
        json: { kind: JOB_KIND_BY_OPERATION[operation.key] },
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message ?? messages().jobStartFailed);
      }

      return await response.json();
    },
  });

  const handleRun = async (operation: OperationConfig) => {
    const confirmed = await prompts.confirm(operation.description, {
      title: operation.label,
      icon: operation.icon,
      confirmText: operation.confirmText,
      cancelText: messages().cancel,
    });
    if (!confirmed) return;

    try {
      activeOperationKey = operation.key;
      await runMutation.mutate(operation);
      const shouldOpenLogs = await prompts.confirm(operation.successText, {
        title: messages().jobStarted,
        icon: "ti ti-check",
        confirmText: messages().showLogs,
        cancelText: messages().stayHere,
        variant: "success",
      });
      if (shouldOpenLogs) {
        navigateTo(operation.redirectTo);
      }
    } catch (error) {
      await prompts.error(error instanceof Error ? error.message : String(error));
    } finally {
      activeOperationKey = null;
    }
  };

  return (
    <div class="flex flex-col gap-2">
      {operations()
        .filter((operation) => props.freeIpaEnabled || operation.key !== "ipa-backfill")
        .map((operation) => {
          const isLoading = () => runMutation.loading() && activeOperationKey === operation.key;
          return (
            <Paper class="flex flex-col gap-3 px-4 py-4 md:flex-row md:items-center md:gap-4">
              <div class="flex min-w-0 flex-1 items-start gap-3">
                <i class={isLoading() ? "ti ti-loader-2 animate-spin text-sm" : `${operation.icon} text-sm`} />
                <div class="min-w-0">
                  <h3 class="text-sm font-medium text-primary">{operation.label}</h3>
                  <p class="text-xs text-dimmed">{operation.description}</p>
                </div>
              </div>
              <Button
                size="sm"
                variant="secondary"
                class="w-full justify-center md:w-auto md:min-w-48"
                onClick={() => void handleRun(operation)}
                disabled={runMutation.loading()}
              >
                {isLoading() ? operation.loadingText : operation.label}
              </Button>
            </Paper>
          );
        })}
      <Paper class="flex flex-col gap-3 px-4 py-4 md:flex-row md:items-center md:gap-4">
        <div class="flex min-w-0 flex-1 items-start gap-3">
          <i class="ti ti-calendar-time text-sm" />
          <div class="min-w-0">
            <h3 class="text-sm font-medium text-primary">{messages().scheduledJobs}</h3>
            <p class="text-xs text-dimmed">{messages().scheduledJobsDescription}</p>
          </div>
        </div>
        <ButtonLink href={SCHEDULED_JOBS_HREF} size="sm" variant="secondary" class="w-full justify-center md:w-auto md:min-w-48">
          {messages().openScheduledJobs}
        </ButtonLink>
      </Paper>
    </div>
  );
}

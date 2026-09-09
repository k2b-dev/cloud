// Platform lifecycle backfill endpoints are owned by cloud-lib (not by an app),
// so the typed client is a cloud-lib export and is identical regardless of
// which container loads it.

import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, ButtonLink, NoticeCard, prompts, SettingsSection, toast } from "@k2b/ui";
import { coreClient } from "@k2b/cloud/clients/core";
import { createSignal, Show } from "solid-js";
import { useOperationMessages } from "./account-operations-messages";

type OperationKey = "ipa-backfill" | "local-user-backfill" | "guest-backfill";

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
const ACCOUNT_LOGS_HREF = `/admin/observability/logs?${new URLSearchParams([
  ...[
    "auth:ipa:sync",
    "auth:ipa:backfill",
    "auth:local-user:backfill",
    "auth:guest:backfill",
    "auth:reminder:daily",
    "auth:guest:cleanup",
    "auth:local-user:cleanup",
    "auth:lifecycle:scheduler",
  ].map((source) => ["source", source]),
  ["window", "7d"],
])}`;

export default function AdminOperations(props: { freeIpaEnabled: boolean }) {
  const messages = useOperationMessages();
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
      key: "guest-backfill",
      label: messages().forceLocalGuestBackfill,
      icon: "ti ti-user-exclamation",
      redirectTo: "/admin/observability/logs?source=auth:guest:backfill",
      confirmText: messages().startLocalGuestBackfill,
      loadingText: messages().startingLocalGuestBackfill,
      successText: messages().localGuestBackfillStarted,
      description: messages().localGuestBackfillDescription,
    },
  ];
  const [activeOperationKey, setActiveOperationKey] = createSignal<OperationKey | null>(null);
  const runMutation = mutations.create<{ message?: string; jobId?: string }, OperationConfig>({
    mutation: async (operation) => {
      const response = await coreClient.admin.lifecycle.jobs.$post({
        json: { kind: operation.key },
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message ?? messages().jobStartFailed);
      }

      return await response.json();
    },
  });

  const handleRun = async (operation: OperationConfig) => {
    if (activeOperationKey()) return;
    setActiveOperationKey(operation.key);
    try {
      const confirmed = await prompts.confirm(`${operation.description} ${messages().expiryWarning}`, {
        title: operation.label,
        icon: operation.icon,
        confirmText: operation.confirmText,
        cancelText: messages().cancel,
      });
      if (!confirmed) return;

      await runMutation.mutate(operation);
      const error = runMutation.error();
      if (error) throw error;
      toast.success(operation.successText);
    } catch (error) {
      await prompts.error(error instanceof Error ? error.message : String(error));
    } finally {
      setActiveOperationKey(null);
    }
  };

  return (
    <div class="flex flex-col gap-2">
      <SettingsSection title={messages().activity}>
        <p class="text-sm text-dimmed">{messages().activityDescription}</p>
        <div class="flex flex-wrap gap-2">
          <ButtonLink href={ACCOUNT_LOGS_HREF} size="sm" variant="secondary">
            {messages().allAccountLogs}
          </ButtonLink>
          <Show when={props.freeIpaEnabled}>
            <ButtonLink href="/admin/observability/logs?source=auth:ipa:sync&window=7d" size="sm" variant="secondary">
              {messages().syncLogs}
            </ButtonLink>
          </Show>
          <ButtonLink href={SCHEDULED_JOBS_HREF} size="sm" variant="secondary">
            {messages().openScheduledJobs}
          </ButtonLink>
        </div>
      </SettingsSection>
      <SettingsSection title={messages().expiryMaintenance}>
        <NoticeCard tone="warning" title={messages().expiryWarning} />
        {operations()
          .filter((operation) => props.freeIpaEnabled || operation.key !== "ipa-backfill")
          .map((operation) => {
            const isLoading = () => runMutation.loading() && activeOperationKey() === operation.key;
            return (
              <div class="flex flex-col gap-3 border-t border-[var(--ui-border)] py-3 md:flex-row md:items-center md:gap-4">
                <div class="flex min-w-0 flex-1 items-start gap-3">
                  <i class={isLoading() ? "ti ti-loader-2 animate-spin text-sm" : `${operation.icon} text-sm`} />
                  <div class="min-w-0">
                    <h3 class="text-sm font-medium text-primary">{operation.label}</h3>
                    <p class="text-xs text-dimmed">{operation.description}</p>
                  </div>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                  <ButtonLink
                    href={operation.redirectTo}
                    size="sm"
                    variant="secondary"
                    aria-label={`${messages().showLogs}: ${operation.label}`}
                  >
                    {messages().showLogs}
                  </ButtonLink>
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={`${messages().run}: ${operation.label}`}
                    onClick={() => void handleRun(operation)}
                    disabled={activeOperationKey() !== null}
                  >
                    {isLoading() ? operation.loadingText : messages().run}
                  </Button>
                </div>
              </div>
            );
          })}
      </SettingsSection>
    </div>
  );
}

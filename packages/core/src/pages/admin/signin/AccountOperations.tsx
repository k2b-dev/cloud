// Platform lifecycle backfill endpoints are owned by cloud-lib (not by an app), so the typed client is a cloud-lib
// export and is identical regardless of which container loads it.
import { coreClient } from "@k2b/cloud/clients/core";
import { Dialog, Notice, Row, Section, useToast } from "@k2b/ui/v2";
import { createSignal, For } from "solid-js";
import { useOperationMessages } from "../settings/_components/account-operations-messages";

type OperationKey = "ipa-backfill" | "local-user-backfill" | "guest-backfill";

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

/**
 * Account maintenance on v2: where account work is logged, and the three backfills, each started after one question.
 * A row opens the logs of its job; its one deed starts it.
 */
export default function AccountOperations(props: { freeIpaEnabled: boolean }) {
  const m = useOperationMessages();
  const toast = useToast();
  const [running, setRunning] = createSignal<OperationKey | null>(null);
  const operations = () =>
    [
      {
        key: "ipa-backfill" as const,
        label: m().forceIpaBackfill,
        logs: "/admin/observability/logs?source=auth:ipa:backfill",
        confirm: m().startIpaBackfill,
        done: m().ipaBackfillStarted,
        description: m().ipaBackfillDescription,
      },
      {
        key: "local-user-backfill" as const,
        label: m().forceLocalUserBackfill,
        logs: "/admin/observability/logs?source=auth:local-user:backfill",
        confirm: m().startLocalUserBackfill,
        done: m().localUserBackfillStarted,
        description: m().localUserBackfillDescription,
      },
      {
        key: "guest-backfill" as const,
        label: m().forceLocalGuestBackfill,
        logs: "/admin/observability/logs?source=auth:guest:backfill",
        confirm: m().startLocalGuestBackfill,
        done: m().localGuestBackfillStarted,
        description: m().localGuestBackfillDescription,
      },
    ].filter((operation) => props.freeIpaEnabled || operation.key !== "ipa-backfill");

  const run = async (operation: ReturnType<typeof operations>[number]) => {
    if (running()) return;
    if (
      !(await Dialog.confirm({
        title: operation.label,
        description: `${operation.description} ${m().expiryWarning}`,
        confirm: operation.confirm,
      }))
    )
      return;
    setRunning(operation.key);
    try {
      const response = await coreClient.admin.lifecycle.jobs.$post({ json: { kind: operation.key } });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(data?.message ?? m().jobStartFailed);
      }
      toast(operation.done, { status: "ok" });
    } catch (error) {
      toast(error instanceof Error ? error.message : m().jobStartFailed, { status: "bad" });
    } finally {
      setRunning(null);
    }
  };

  return (
    <>
      <Section icon="list-details" title={m().activity} summary={m().activityDescription}>
        <Row lines={[m().allAccountLogs]} icon="file-text" href={ACCOUNT_LOGS_HREF} />
        {props.freeIpaEnabled ? (
          <Row lines={[m().syncLogs]} icon="refresh" href="/admin/observability/logs?source=auth:ipa:sync&window=7d" />
        ) : null}
        <Row lines={[m().openScheduledJobs]} icon="clock" href={SCHEDULED_JOBS_HREF} />
      </Section>
      <Section icon="user-exclamation" title={m().expiryMaintenance}>
        <Notice tone="warn">{m().expiryWarning}</Notice>
        <For each={operations()}>
          {(operation) => (
            <Row
              lines={[operation.label, operation.description]}
              icon="user-exclamation"
              href={operation.logs}
              action={{
                label: m().run,
                icon: "player-play",
                onClick: () => void run(operation),
                disabled: running() !== null,
              }}
            />
          )}
        </For>
      </Section>
    </>
  );
}

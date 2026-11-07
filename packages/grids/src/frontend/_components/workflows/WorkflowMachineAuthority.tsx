import { EntitySearch } from "@k2b/cloud/account/ui";
import { mutation, query } from "@k2b/stdlib/solid";
import { Button, NoticeCard, Placeholder, Tag, useLocale } from "@k2b/ui";
import { createEffect, onCleanup, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import { type WorkflowMachineAuthorityChange, WorkflowMachineAuthoritySchema } from "../../../workflows/contracts";
import { machineWorkflowMessages } from "./machine-workflow-messages";

export function WorkflowMachineAuthority(props: { workflowId: string; onBusy?: (value: boolean) => void }) {
  const locale = useLocale();
  const t = () => machineWorkflowMessages.resolve([locale()]).t;
  const api = apiClient.workflows[":workflowId"]["machine-authority"];
  const current = query.create({
    source: () => props.workflowId,
    load: async (id, { abortSignal }) => {
      const response = await api.$get({ param: { workflowId: id } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(t().loadFailed);
      return { workflowId: id, ...WorkflowMachineAuthoritySchema.parse(await response.json()) };
    },
  });
  const change = mutation.create({
    mutation: async (input: WorkflowMachineAuthorityChange, { abortSignal }) => {
      const response = await api.$put({ param: { workflowId: props.workflowId }, json: input }, { init: { signal: abortSignal } });
      if (!response.ok) {
        if (response.status === 409) {
          await current.refresh();
          throw new Error(t().conflict);
        }
        throw new Error(t().changeFailed);
      }
    },
    onSuccess: () => current.refresh(),
  });
  createEffect(() => props.onBusy?.(change.loading()));
  onCleanup(() => props.onBusy?.(false));
  const snapshot = () => (current.data()?.workflowId === props.workflowId ? current.data() : undefined);
  const expected = () => ({
    serviceAccountId: snapshot()!.serviceAccountId,
    mandate: snapshot()!.mandate ? { id: snapshot()!.mandate!.id, revision: snapshot()!.mandate!.revision } : null,
  });
  const busy = () => Boolean(current.error()) || change.loading() || current.loading() || current.refreshing();
  return (
    <section class="flex flex-col gap-3" aria-busy={busy()}>
      <h3 class="font-medium">{t().title}</h3>
      <p class="text-sm text-dimmed">{t().hint}</p>
      <Show when={current.loading()}>
        <Placeholder description={t().loading} />
      </Show>
      <Show when={current.error()}>
        <NoticeCard tone="danger">
          <p>{t().loadFailed}</p>
          <Button size="sm" variant="secondary" onClick={() => current.refresh()}>
            {t().retry}
          </Button>
        </NoticeCard>
      </Show>
      <Show when={change.error()}>
        <NoticeCard tone="danger" role="alert">
          <p>{change.error()?.message}</p>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy()}
            onClick={() => {
              void current.refresh();
            }}
          >
            {t().reload}
          </Button>
        </NoticeCard>
      </Show>
      <Show when={snapshot()}>
        {(value) => (
          <>
            <Show
              when={value().serviceAccountId}
              fallback={<p class="text-sm">{value().hasHumanOwner ? t().humanOwner : t().missingOwner}</p>}
            >
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-medium">{value().name ?? t().unavailable}</span>
                <Tag>{value().kind === "agent" ? t().agent : t().serviceAccount}</Tag>
                <Tag>
                  {value().mandate?.state === "active" && value().accountStatus === "active"
                    ? t().active
                    : value().mandate?.state === "paused"
                      ? t().paused
                      : t().blocked}
                </Tag>
              </div>
              <p class="text-sm text-dimmed">{t().ceiling}</p>
            </Show>
            <Show when={value().canConfigure} fallback={<p class="text-sm text-dimmed">{t().adminRequired}</p>}>
              <EntitySearch
                includeUsers={false}
                includeGroups={false}
                includeServiceAccounts={true}
                serviceAccountKinds={["standalone", "agent"]}
                serviceAccountStatus="active"
                placeholder={t().choose}
                disabled={busy()}
                onSelect={(item) => {
                  if (item.type === "service_account")
                    void change.mutate({ action: "assign", serviceAccountId: item.serviceAccountId, expected: expected() });
                }}
              />
              <Show when={value().mandate && value().mandate!.state !== "revoked"}>
                <div class="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy()}
                    onClick={() =>
                      change.mutate({
                        action: value().mandate!.state === "paused" ? "resume" : "pause",
                        expected: expected(),
                      })
                    }
                  >
                    {value().mandate!.state === "paused" ? t().resume : t().pause}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy()}
                    onClick={() => change.mutate({ action: "revoke", expected: expected() })}
                  >
                    {t().revoke}
                  </Button>
                </div>
              </Show>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}

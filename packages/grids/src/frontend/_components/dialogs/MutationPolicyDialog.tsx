import { mutation, query } from "@k2b/stdlib/solid";
import {
  Button,
  CheckboxCard,
  confirmDiscardIfDirty,
  dialogCore,
  NoticeCard,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  prompts,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { MutationSource, TableMutationPolicy } from "../../../contracts";
import { errorMessage } from "../utils/api-helpers";
import { gridsDialogMessages } from "./messages";

type MutationPolicyImpactItem = {
  kind: "form" | "workflow" | "action";
  id: string;
  name: string;
};

type MutationPolicyImpact = {
  items: MutationPolicyImpactItem[];
  total: number;
  limit: number;
  truncated: boolean;
  complete: boolean;
};

const SOURCE_OPTIONS: Array<{
  id: MutationSource;
  label: string;
  description: string;
  icon: string;
}> = [
  {
    id: "direct",
    label: "Direct editing and record API",
    description: "Editing in the Base or a Grids App, Record Editor, API, CLI, and imports.",
    icon: "ti ti-edit",
  },
  {
    id: "form",
    label: "Forms",
    description: "Active Forms, including Forms published in a Grids App.",
    icon: "ti ti-forms",
  },
  {
    id: "workflow",
    label: "Workflows and actions",
    description: "Enabled Workflows, run options, and published Grids App actions.",
    icon: "ti ti-route",
  },
];

const ALL_SOURCES = SOURCE_OPTIONS.map((option) => option.id);

const selectedSources = (policy: TableMutationPolicy): MutationSource[] => (policy.mode === "all" ? [...ALL_SOURCES] : policy.sources);

const canonicalPolicy = (policy: TableMutationPolicy): TableMutationPolicy => {
  if (policy.mode === "all") return policy;
  const sources = ALL_SOURCES.filter((source) => policy.sources.includes(source));
  return sources.length === ALL_SOURCES.length ? { mode: "all" } : { mode: "selected", sources };
};

export const mutationPolicySummary = (policy: TableMutationPolicy, locale = "en"): string => {
  const { t } = gridsDialogMessages.resolve([locale]);
  const canonical = canonicalPolicy(policy);
  if (canonical.mode === "all") return t.allSourcesAllowed;
  if (canonical.sources.length === 0) return t.changesFrozen;
  return canonical.sources
    .map((source) => (source === "direct" ? t.directEditing : source === "form" ? t.forms : t.workflowsActions))
    .join(", ");
};

const removedSources = (saved: TableMutationPolicy, draft: TableMutationPolicy): MutationSource[] => {
  const next = new Set(selectedSources(canonicalPolicy(draft)));
  return selectedSources(canonicalPolicy(saved)).filter((source) => !next.has(source));
};

const IMPACT_KIND = {
  form: { label: "Form", icon: "ti ti-forms" },
  workflow: { label: "Workflow", icon: "ti ti-route" },
  action: { label: "Action", icon: "ti ti-bolt" },
} as const;

export const openMutationPolicyDialog = (args: {
  tableId: string;
  tableName: string;
  value: TableMutationPolicy;
}): Promise<TableMutationPolicy | null> =>
  dialogCore
    .open<TableMutationPolicy | null>(
      (close, context) => <MutationPolicyDialog args={args} close={close} setDismissHandler={context.setDismissHandler} />,
      panelDialogOptions,
    )
    .then((result) => result ?? null);

function MutationPolicyDialog(props: {
  args: { tableId: string; tableName: string; value: TableMutationPolicy };
  close: (value: TableMutationPolicy | null) => void;
  setDismissHandler: (handler: () => void | Promise<void>) => void;
}) {
  const locale = useLocale();
  const t = () => gridsDialogMessages.resolve([locale()]).t;
  const sourceOptions = () =>
    SOURCE_OPTIONS.map((option) => ({
      ...option,
      label: option.id === "direct" ? t().directEditing : option.id === "form" ? t().forms : t().workflowsActions,
      description:
        option.id === "direct"
          ? t().directEditingDescription
          : option.id === "form"
            ? t().formsSourceDescription
            : t().workflowsActionsDescription,
    }));
  const impactKind = (kind: MutationPolicyImpactItem["kind"]) => ({
    ...IMPACT_KIND[kind],
    label: kind === "form" ? t().form : kind === "workflow" ? t().workflow : t().action,
  });
  const saved = canonicalPolicy(props.args.value);
  const [policy, setPolicy] = createSignal<TableMutationPolicy>(saved);
  const normalized = createMemo(() => canonicalPolicy(policy()));
  const dirty = () => JSON.stringify(normalized()) !== JSON.stringify(saved);
  const removed = createMemo(() => removedSources(saved, normalized()));
  const policyKey = () => JSON.stringify(normalized());
  const hasRemovedSources = () => removed().length > 0;
  const isFrozen = () => {
    const target = normalized();
    return target.mode === "selected" && target.sources.length === 0;
  };

  const impactQuery = query.create({
    source: policyKey,
    enabled: hasRemovedSources,
    load: async (key, { abortSignal }) => {
      const target = JSON.parse(key) as TableMutationPolicy;
      const response = await apiClient.tables[":tableId"]["mutation-policy"].impact.$post(
        { param: { tableId: props.args.tableId }, json: { policy: target } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, t().impactFailed));
      return { key, impact: (await response.json()) as MutationPolicyImpact };
    },
  });

  const currentImpact = () => {
    const result = impactQuery.data();
    return result?.key === policyKey() ? result.impact : null;
  };
  const impactReady = () => !hasRemovedSources() || (!impactQuery.loading() && !impactQuery.error() && currentImpact() !== null);

  const saveMutation = mutation.create<{ policy: TableMutationPolicy }, void>({
    mutation: async () => {
      const response = await apiClient.tables[":tableId"]["mutation-policy"].$put({
        param: { tableId: props.args.tableId },
        json: { policy: normalized(), ...(isFrozen() ? { confirmFreeze: true as const } : {}) },
      });
      if (!response.ok) throw new Error(await errorMessage(response, t().saveSourcesFailed));
      return response.json();
    },
    onSuccess: (result) => props.close(result.policy),
  });

  const closeIfClean = async () => {
    if (saveMutation.loading()) return;
    if (await confirmDiscardIfDirty(dirty)) props.close(null);
  };
  props.setDismissHandler(closeIfClean);

  const save = async () => {
    if (!dirty() || !impactReady()) return;
    if (isFrozen() && selectedSources(saved).length > 0) {
      const confirmed = await prompts.confirm(t().freezeConfirm({ table: props.args.tableName }), {
        title: t().freezeQuestion,
        confirmText: t().freezeChanges,
        variant: "danger",
        confirmationPhrase: props.args.tableName,
      });
      if (!confirmed) return;
    }
    saveMutation.mutate(undefined);
  };

  const setAll = (allowed: boolean) => {
    if (saveMutation.loading()) return;
    setPolicy(allowed ? { mode: "all" } : { mode: "selected", sources: [...ALL_SOURCES] });
  };

  const setSource = (source: MutationSource, allowed: boolean) => {
    if (saveMutation.loading()) return;
    const current = selectedSources(policy());
    const sources = ALL_SOURCES.filter((candidate) => (candidate === source ? allowed : current.includes(candidate)));
    setPolicy(sources.length === ALL_SOURCES.length ? { mode: "all" } : { mode: "selected", sources });
  };

  return (
    <PanelDialog>
      <PanelDialog.Header title={t().recordChanges} subtitle={props.args.tableName} icon="ti ti-route" close={closeIfClean} />
      <PanelDialog.Body>
        <fieldset disabled={saveMutation.loading()} class="flex min-w-0 flex-col gap-3">
          <Show when={saveMutation.error()}>
            {(error) => (
              <NoticeCard tone="danger" role="alert">
                {error().message}
              </NoticeCard>
            )}
          </Show>
          <NoticeCard tone="info" title={t().chooseChangeSources} detail={t().chooseChangeSourcesDetail} />

          <PanelDialog.Section title={t().allowedSources} subtitle={t().allowedSourcesDescription} icon="ti ti-route">
            <CheckboxCard
              label={t().all}
              description={t().allSourcesDescription}
              icon="ti ti-arrows-exchange"
              value={() => policy().mode === "all"}
              onValueChange={setAll}
            />
            <Show when={policy().mode === "selected"}>
              <div class="grid gap-2">
                <For each={sourceOptions()}>
                  {(option) => (
                    <CheckboxCard
                      label={option.label}
                      description={option.description}
                      icon={option.icon}
                      variant="input"
                      value={() => selectedSources(policy()).includes(option.id)}
                      onValueChange={(allowed) => setSource(option.id, allowed)}
                    />
                  )}
                </For>
              </div>
            </Show>
            <Show when={isFrozen()}>
              <NoticeCard tone="warning" title={t().freezeWarning} detail={t().freezeWarningDetail} />
            </Show>
          </PanelDialog.Section>

          <Show when={hasRemovedSources()}>
            <PanelDialog.Section title={t().stopsWorking} subtitle={t().stopsWorkingDescription} icon="ti ti-alert-triangle">
              <Show when={!impactQuery.loading()} fallback={<Placeholder state="loading" align="left" title={t().checkingEntryPoints} />}>
                <Show
                  when={!impactQuery.error()}
                  fallback={
                    <Placeholder
                      state="error"
                      align="left"
                      title={t().entryPointsUnavailable}
                      description={impactQuery.error()?.message}
                      action={
                        <Button variant="secondary" size="sm" type="button" onClick={() => void impactQuery.refresh()}>
                          {t().retry}
                        </Button>
                      }
                    />
                  }
                >
                  <Show when={currentImpact()}>
                    {(impact) => (
                      <Show
                        when={impact().total > 0 || !impact().complete}
                        fallback={<NoticeCard tone="neutral" title={t().noEntryPoints} detail={t().noEntryPointsDetail} />}
                      >
                        <NoticeCard
                          tone="warning"
                          title={
                            !impact().complete && impact().total === 0
                              ? t().moreMayBeAffected
                              : t().impactCount({ count: impact().total, incomplete: !impact().complete })
                          }
                          detail={
                            !impact().complete
                              ? t().impactLimited
                              : impact().truncated
                                ? t().impactShown({ shown: impact().items.length, total: impact().total })
                                : t().reviewEntryPoints
                          }
                        />
                        <ul class="paper divide-y divide-[var(--ui-border)]" aria-label={t().affectedEntryPoints}>
                          <For each={impact().items}>
                            {(item) => (
                              <li class="flex items-center gap-3 px-3 py-2">
                                <i class={`${impactKind(item.kind).icon} text-base text-dimmed`} aria-hidden="true" />
                                <span class="min-w-0 flex-1 truncate text-sm font-medium text-primary">{item.name}</span>
                                <span class="text-xs text-dimmed">{impactKind(item.kind).label}</span>
                              </li>
                            )}
                          </For>
                        </ul>
                      </Show>
                    )}
                  </Show>
                </Show>
              </Show>
            </PanelDialog.Section>
          </Show>
        </fieldset>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <span />
        <div class="flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" type="button" onClick={closeIfClean}>
            {t().cancel}
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="button"
            onClick={() => void save()}
            disabled={!dirty() || !impactReady()}
            loading={saveMutation.loading()}
            loadingLabel={t().savingSources}
          >
            {t().save}
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

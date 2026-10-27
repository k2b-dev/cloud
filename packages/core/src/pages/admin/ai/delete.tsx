import {
  type AiModel,
  type AiModelSlot,
  type AiModelUsage,
  type AiModelVariant,
  type AiProvider,
  aiModelClassFallbackChain,
} from "@k2b/cloud/shared";
import { Button, dialogCore, NoticeCard, PanelDialog, Placeholder, panelDialogOptions, RichSelect, Switch, useLocale } from "@k2b/ui";
import { createResource, createSignal, For, Show } from "solid-js";
import { aiAreaHref } from "./area";
import { aiAdminApi, readAiAdmin, reloadAiArea } from "./client";
import { aiAreaMessages } from "./messages";
import { type AiAreaMessages, aiSlotLabel, aiVariantName, isAiModelClass } from "./presentation";

export type AiDeleteTarget =
  | { kind: "provider"; provider: AiProvider }
  | { kind: "model"; model: AiModel; provider: AiProvider }
  | { kind: "variant"; variant: AiModelVariant; model: AiModel; provider: AiProvider };

type Catalog = {
  providers: AiProvider[];
  models: AiModel[];
  variants: AiModelVariant[];
  assignments: Record<AiModelSlot, { variantId: string | null }>;
  usage: AiModelUsage;
};

const NONE = "__none";

const emptyUsage = (): AiModelUsage => ({
  assignments: [],
  projects: [],
  workflows: [],
  scheduledTasks: [],
  chats: 0,
  budgetRules: [],
  peopleAtLimit: 0,
  stats: { answers14d: 0, avgCostPerAnswer: null, avgSecondsPerAnswer: null },
});

const mergeUsage = (all: AiModelUsage[]): AiModelUsage =>
  all.reduce(
    (sum, usage) => ({
      ...sum,
      assignments: [...new Set([...sum.assignments, ...usage.assignments])],
      projects: [...sum.projects, ...usage.projects.filter((entry) => !sum.projects.some((known) => known.id === entry.id))],
      workflows: [...sum.workflows, ...usage.workflows.filter((entry) => !sum.workflows.some((known) => known.id === entry.id))],
      scheduledTasks: [
        ...sum.scheduledTasks,
        ...usage.scheduledTasks.filter((entry) => !sum.scheduledTasks.some((known) => known.id === entry.id)),
      ],
      chats: sum.chats + usage.chats,
      budgetRules: [...sum.budgetRules, ...usage.budgetRules.filter((entry) => !sum.budgetRules.some((known) => known.id === entry.id))],
    }),
    emptyUsage(),
  );

const loadCatalog = async (target: AiDeleteTarget, t: AiAreaMessages): Promise<Catalog> => {
  const [providers, models, overview] = await Promise.all([
    aiAdminApi.providers.$get().then((response) => readAiAdmin<{ providers: AiProvider[] }>(response, t.loadFailed)),
    aiAdminApi.models.$get().then((response) => readAiAdmin<{ models: AiModel[] }>(response, t.loadFailed)),
    aiAdminApi.overview
      .$get()
      .then((response) => readAiAdmin<{ assignments: Record<AiModelSlot, { variantId: string | null }> }>(response, t.loadFailed)),
  ]);
  const details = await Promise.all(
    models.models.map((model) =>
      aiAdminApi.models[":id"]
        .$get({ param: { id: model.id } })
        .then((response) => readAiAdmin<AiModel & { variants: AiModelVariant[] }>(response, t.loadFailed)),
    ),
  );
  const affectedModels =
    target.kind === "provider" ? models.models.filter((model) => model.providerId === target.provider.id).map((model) => model.id) : [];
  const usage =
    target.kind === "variant"
      ? await aiAdminApi.variants[":id"].usage
          .$get({ param: { id: target.variant.id } })
          .then((response) => readAiAdmin<AiModelUsage>(response, t.loadFailed))
      : mergeUsage(
          await Promise.all(
            (target.kind === "model" ? [target.model.id] : affectedModels).map((id) =>
              aiAdminApi.models[":id"].usage.$get({ param: { id } }).then((response) => readAiAdmin<AiModelUsage>(response, t.loadFailed)),
            ),
          ),
        );
  return {
    providers: providers.providers,
    models: models.models,
    variants: details.flatMap((detail) => detail.variants),
    assignments: overview.assignments,
    usage,
  };
};

/** B4: everything a delete changes, a replacement for every slot it fills, and the switch that moves references. */
function DeleteDialog(props: { target: AiDeleteTarget; close: () => void }) {
  const locale = useLocale();
  const t = () => aiAreaMessages.resolve([locale()]).t;
  const [catalog, { refetch }] = createResource(() => loadCatalog(props.target, t()));
  const [replacements, setReplacements] = createSignal<Partial<Record<AiModelSlot, string>>>({});
  const [retarget, setRetarget] = createSignal(true);
  const [retargetTo, setRetargetTo] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  const name = () =>
    props.target.kind === "provider"
      ? props.target.provider.label
      : props.target.kind === "model"
        ? props.target.model.label
        : aiVariantName(props.target.model, props.target.variant);
  const sourceProvider = () => props.target.provider;
  const removedVariantIds = (data: Catalog) =>
    props.target.kind === "variant"
      ? [props.target.variant.id]
      : data.variants
          .filter((variant) => {
            const model = data.models.find((candidate) => candidate.id === variant.modelId);
            return props.target.kind === "provider"
              ? model?.providerId === props.target.provider.id
              : variant.modelId === props.target.model.id;
          })
          .map((variant) => variant.id);
  const assignedSlots = (data: Catalog): AiModelSlot[] =>
    (Object.keys(data.assignments) as AiModelSlot[]).filter((slot) =>
      removedVariantIds(data).includes(data.assignments[slot]?.variantId ?? ""),
    );

  /** Same or stricter data boundary; the right kind and capability for the slot. */
  const candidates = (data: Catalog, slot: AiModelSlot | null) =>
    data.variants.flatMap((variant) => {
      if (removedVariantIds(data).includes(variant.id)) return [];
      const model = data.models.find((candidate) => candidate.id === variant.modelId);
      const provider = model ? data.providers.find((candidate) => candidate.id === model.providerId) : undefined;
      if (!model || !provider || !model.enabled || !provider.enabled) return [];
      if (sourceProvider().dataBoundary === "private" && provider.dataBoundary !== "private") return [];
      if (slot === "audio" ? model.kind !== "transcription" : model.kind !== "chat") return [];
      if (slot === "vision" && !model.capabilities.includes("vision")) return [];
      return [
        {
          value: variant.id,
          label: aiVariantName(model, variant),
          description: provider.label,
          section: provider.id,
        },
      ];
    });
  const sections = (data: Catalog) => data.providers.map((provider) => ({ id: provider.id, label: provider.label }));

  const emptyLabel = (data: Catalog, slot: AiModelSlot) => {
    if (!isAiModelClass(slot)) return t().leaveEmpty;
    const next = aiModelClassFallbackChain(slot).find(
      (modelClass) =>
        data.assignments[modelClass]?.variantId && !removedVariantIds(data).includes(data.assignments[modelClass]?.variantId ?? ""),
    );
    return next ? t().leaveEmptyUses({ p: aiSlotLabel(t(), next) }) : t().leaveEmpty;
  };

  const hasReferences = (data: Catalog) => data.usage.projects.length + data.usage.workflows.length + data.usage.scheduledTasks.length > 0;
  const ready = (data: Catalog) =>
    assignedSlots(data).every((slot) => replacements()[slot]) && (!retarget() || !hasReferences(data) || Boolean(retargetTo()));

  const confirm = async () => {
    const data = catalog();
    if (!data || !ready(data)) return;
    setBusy(true);
    setError("");
    const target = props.target;
    const json = {
      revision:
        target.kind === "provider" ? target.provider.revision : target.kind === "model" ? target.model.revision : target.variant.revision,
      replacements: Object.fromEntries(
        assignedSlots(data).map((slot) => [slot, replacements()[slot] === NONE ? null : (replacements()[slot] ?? null)]),
      ),
      retarget: retarget() && hasReferences(data),
      retargetTo: retarget() && hasReferences(data) ? retargetTo() : null,
    };
    try {
      const response =
        target.kind === "provider"
          ? await aiAdminApi.providers[":id"].$delete({ param: { id: target.provider.id }, json })
          : target.kind === "model"
            ? await aiAdminApi.models[":id"].$delete({ param: { id: target.model.id }, json })
            : await aiAdminApi.variants[":id"].$delete({ param: { id: target.variant.id }, json });
      await readAiAdmin(response, t().saveFailed);
      props.close();
      reloadAiArea(
        target.kind === "provider"
          ? aiAreaHref({ sec: "providers" })
          : target.kind === "model"
            ? aiAreaHref({ sec: "providers", p: target.provider.id })
            : undefined,
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t().saveFailed);
      setBusy(false);
    }
  };

  const fact = (icon: string, text: string) => (
    <li class="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2 text-sm">
      <i class={`ti ${icon} pt-0.5 text-(--k2b-text-muted)`} aria-hidden="true" />
      <span>{text}</span>
    </li>
  );

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={props.target.kind === "provider" ? t().delProvTitle({ p: name() }) : t().delTitle({ p: name() })}
        icon="ti ti-trash"
        close={props.close}
        closeDisabled={busy()}
      />
      <PanelDialog.Body scrollPreserveKey="ai-delete">
        <Show when={catalog.state === "pending" || catalog.state === "refreshing"}>
          <Placeholder state="loading" title={t().modelsLoading} />
        </Show>
        <Show when={catalog.state === "errored"}>
          <Placeholder
            state="error"
            title={t().loadFailed}
            action={
              <Button type="button" variant="secondary" size="sm" onClick={() => void refetch()}>
                <i class="ti ti-refresh" aria-hidden="true" />
                {t().retry}
              </Button>
            }
          />
        </Show>
        <Show when={catalog.state === "ready" ? catalog() : undefined}>
          {(data) => (
            <>
              <Show when={assignedSlots(data()).length > 0}>
                <PanelDialog.Section title={t().delUsedAs} subtitle={t().delBoundary}>
                  <div class="grid gap-3">
                    <For each={assignedSlots(data())}>
                      {(slot) => (
                        <RichSelect
                          label={aiSlotLabel(t(), slot)}
                          title={`${t().delPick}: ${aiSlotLabel(t(), slot)}`}
                          placeholder={t().delPick}
                          items={[{ value: NONE, label: emptyLabel(data(), slot), section: "none" }, ...candidates(data(), slot)]}
                          sections={[{ id: "none", label: t().clsUnassigned }, ...sections(data())]}
                          value={() => replacements()[slot] ?? null}
                          onValueChange={(value) => {
                            if (value) setReplacements((current) => ({ ...current, [slot]: value }));
                            if (slot === "balanced" && value && value !== NONE && !retargetTo()) setRetargetTo(value);
                          }}
                          disabled={busy()}
                        />
                      )}
                    </For>
                  </div>
                </PanelDialog.Section>
              </Show>
              <PanelDialog.Section title={t().delEffects}>
                <ul class="grid gap-2">
                  {fact("ti-messages", t().delChats({ p: data().usage.chats }))}
                  <Show when={data().usage.projects.length > 0}>
                    {fact(
                      "ti-folders",
                      t().delProjects({
                        p: data()
                          .usage.projects.map((entry) => entry.name)
                          .join(", "),
                      }),
                    )}
                  </Show>
                  <Show when={data().usage.scheduledTasks.length > 0}>
                    {fact(
                      "ti-clock",
                      t().delTasks({
                        p: data()
                          .usage.scheduledTasks.map((entry) => entry.name)
                          .join(", "),
                      }),
                    )}
                  </Show>
                  <Show when={data().usage.workflows.length > 0}>
                    {fact(
                      "ti-route",
                      t().delWorkflows({
                        p: data()
                          .usage.workflows.map((entry) => entry.name)
                          .join(", "),
                      }),
                    )}
                  </Show>
                  <Show when={data().usage.budgetRules.length > 0}>
                    {fact(
                      "ti-gauge",
                      t().delBudgets({
                        p: data()
                          .usage.budgetRules.map((entry) => entry.label)
                          .join(", "),
                      }),
                    )}
                  </Show>
                  {fact("ti-api", t().delRunning)}
                </ul>
                <Show when={hasReferences(data())}>
                  <div class="mt-4 grid gap-3">
                    <Switch
                      label={t().delMove}
                      description={t().delMoveHelp}
                      value={retarget}
                      onValueChange={setRetarget}
                      disabled={busy()}
                    />
                    <Show when={retarget()}>
                      <RichSelect
                        label={t().delRefTarget}
                        placeholder={t().delPick}
                        items={candidates(data(), null)}
                        sections={sections(data())}
                        value={retargetTo}
                        onValueChange={setRetargetTo}
                        disabled={busy()}
                      />
                    </Show>
                  </div>
                </Show>
              </PanelDialog.Section>
            </>
          )}
        </Show>
        <Show when={error()}>
          <NoticeCard tone="danger" title={t().saveFailed} detail={error()} />
        </Show>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button type="button" variant="secondary" size="sm" onClick={props.close} disabled={busy()}>
          {t().cancel}
        </Button>
        <Button
          type="button"
          variant="danger"
          size="sm"
          loading={busy()}
          disabled={catalog.state !== "ready" || !ready(catalog()!)}
          onClick={() => void confirm()}
        >
          <i class="ti ti-trash" aria-hidden="true" />
          {catalog.state === "ready" && assignedSlots(catalog()!).length ? t().delConfirm : t().delSimple}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export const openAiDelete = (target: AiDeleteTarget) =>
  void dialogCore.open<void>((close) => <DeleteDialog target={target} close={() => close()} />, panelDialogOptions);

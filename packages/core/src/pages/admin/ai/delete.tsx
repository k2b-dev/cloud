import {
  type AiModel,
  type AiModelSlot,
  type AiModelUsage,
  type AiModelVariant,
  type AiProvider,
  aiModelClassFallbackChain,
  aiModelSupportsSlot,
  aiReplacementProblem,
} from "@k2b/cloud/shared";
import { Button, Check, Dialog, Failed, Field, Loading, Notice, Row, Section, Select, useLocale } from "@k2b/ui/v2";
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
  referenceModels: string[];
};

const NONE = "__none";

const emptyUsage = (): AiModelUsage => ({
  assignments: [],
  projects: [],
  workflows: [],
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
  const modelUsages = await Promise.all(
    (target.kind === "variant" ? [target.model.id] : target.kind === "model" ? [target.model.id] : affectedModels).map(async (id) => ({
      modelId: id,
      usage: await (target.kind === "variant"
        ? aiAdminApi.variants[":id"].usage.$get({ param: { id: target.variant.id } })
        : aiAdminApi.models[":id"].usage.$get({ param: { id } })
      ).then((response) => readAiAdmin<AiModelUsage>(response, t.loadFailed)),
    })),
  );
  const usage = mergeUsage(modelUsages.map((entry) => entry.usage));
  return {
    providers: providers.providers,
    models: models.models,
    variants: details.flatMap((detail) => detail.variants),
    assignments: overview.assignments,
    usage,
    referenceModels: modelUsages.filter(({ usage }) => usage.projects.length + usage.workflows.length > 0).map((entry) => entry.modelId),
  };
};

/**
 * B4: everything a delete changes, a replacement for every slot it fills, and the switch that moves references. The
 * dialog is the screen's: it opens with a target and reads the catalog while open.
 */
export function DeleteDialog(props: { target: AiDeleteTarget | null; onClose: () => void }) {
  const locale = useLocale();
  const t = () => aiAreaMessages.resolve([locale()]).t;
  const [catalog, { refetch }] = createResource(
    () => props.target,
    (target) => loadCatalog(target, t()),
  );
  const [replacements, setReplacements] = createSignal<Partial<Record<AiModelSlot, string>>>({});
  const [retarget, setRetarget] = createSignal(true);
  const [retargetTo, setRetargetTo] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const close = (open: boolean) => {
    if (open || busy()) return;
    setReplacements({});
    setRetargetTo(null);
    setError("");
    props.onClose();
  };

  const name = (target: AiDeleteTarget) =>
    target.kind === "provider"
      ? target.provider.label
      : target.kind === "model"
        ? target.model.label
        : `${target.model.label} · ${target.variant.label}`;
  const removedVariantIds = (data: Catalog, target: AiDeleteTarget) =>
    target.kind === "variant"
      ? [target.variant.id]
      : data.variants
          .filter((variant) => {
            const model = data.models.find((candidate) => candidate.id === variant.modelId);
            return target.kind === "provider" ? model?.providerId === target.provider.id : variant.modelId === target.model.id;
          })
          .map((variant) => variant.id);
  const assignedSlots = (data: Catalog, target: AiDeleteTarget): AiModelSlot[] =>
    (Object.keys(data.assignments) as AiModelSlot[]).filter((slot) =>
      removedVariantIds(data, target).includes(data.assignments[slot]?.variantId ?? ""),
    );

  /** Same or stricter data boundary; the right kind and capability for the slot. Named with their provider. */
  const candidates = (data: Catalog, target: AiDeleteTarget, slot: AiModelSlot | null) =>
    data.variants.flatMap((variant) => {
      if (removedVariantIds(data, target).includes(variant.id)) return [];
      const model = data.models.find((candidate) => candidate.id === variant.modelId);
      const provider = model ? data.providers.find((candidate) => candidate.id === model.providerId) : undefined;
      if (!model || !provider) return [];
      const sourceVariant = slot ? data.assignments[slot]?.variantId : null;
      const originals = slot
        ? data.models.filter((entry) => entry.id === data.variants.find((candidate) => candidate.id === sourceVariant)?.modelId)
        : data.models.filter((entry) => data.referenceModels.includes(entry.id));
      if (
        !originals.length ||
        originals.some((original) => {
          const source = data.providers.find((entry) => entry.id === original.providerId);
          return !source || aiReplacementProblem(source, provider, original, model) !== null;
        })
      )
        return [];
      if (slot && !aiModelSupportsSlot(slot, model)) return [];
      // k2b-ui gap: Select has no option groups; the provider stands before the model's name instead
      return [{ value: variant.id, label: `${provider.label} · ${aiVariantName(model, variant, data.variants)}` }];
    });

  const emptyLabel = (data: Catalog, target: AiDeleteTarget, slot: AiModelSlot) => {
    if (!isAiModelClass(slot)) return t().leaveEmpty;
    const next = aiModelClassFallbackChain(slot).find(
      (modelClass) =>
        data.assignments[modelClass]?.variantId && !removedVariantIds(data, target).includes(data.assignments[modelClass]?.variantId ?? ""),
    );
    return next ? t().leaveEmptyUses({ p: aiSlotLabel(t(), next) }) : t().leaveEmpty;
  };

  const hasReferences = (data: Catalog) => data.usage.projects.length + data.usage.workflows.length > 0;
  const ready = (data: Catalog, target: AiDeleteTarget) =>
    assignedSlots(data, target).every((slot) => replacements()[slot]) && (!retarget() || !hasReferences(data) || Boolean(retargetTo()));

  const confirm = async () => {
    const data = catalog();
    const target = props.target;
    if (!data || !target || !ready(data, target)) return;
    setBusy(true);
    setError("");
    const json = {
      revision:
        target.kind === "provider" ? target.provider.revision : target.kind === "model" ? target.model.revision : target.variant.revision,
      replacements: Object.fromEntries(
        assignedSlots(data, target).map((slot) => [slot, replacements()[slot] === NONE ? null : (replacements()[slot] ?? null)]),
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

  const fact = (icon: string, text: string) => <Row icon={icon} lines={[text]} />;
  const loaded = () => (catalog.state === "ready" ? catalog() : undefined);

  return (
    <Dialog
      title={
        props.target
          ? props.target.kind === "provider"
            ? t().delProvTitle({ p: name(props.target) })
            : t().delTitle({ p: name(props.target) })
          : ""
      }
      open={props.target !== null}
      onOpenChange={close}
      dismissible={!busy()}
      foot={
        <>
          <Button disabled={busy()} onClick={() => close(false)}>
            {t().cancel}
          </Button>
          {/* k2b-ui gap: a destructive primary deed in a dialog is not red yet (#4275) */}
          <Button
            variant="primary"
            icon="trash"
            busy={busy()}
            disabled={!loaded() || !props.target || !ready(loaded()!, props.target)}
            onClick={() => void confirm()}
          >
            {loaded() && props.target && assignedSlots(loaded()!, props.target).length ? t().delConfirm : t().delSimple}
          </Button>
        </>
      }
    >
      <Show when={catalog.state === "pending" || catalog.state === "refreshing"}>
        <Loading rows={3} />
      </Show>
      <Show when={catalog.state === "errored"}>
        <Failed text={t().loadFailed} onRetry={() => void refetch()} />
      </Show>
      <Show when={loaded() && props.target ? { data: loaded()!, target: props.target } : undefined}>
        {(current) => (
          <>
            <Show when={assignedSlots(current().data, current().target).length > 0}>
              <Section title={t().delUsedAs} summary={t().delBoundary}>
                <For each={assignedSlots(current().data, current().target)}>
                  {(slot) => (
                    <Field label={aiSlotLabel(t(), slot)}>
                      <Select
                        placeholder={t().delPick}
                        value={replacements()[slot]}
                        disabled={busy()}
                        options={[
                          { value: NONE, label: emptyLabel(current().data, current().target, slot) },
                          ...candidates(current().data, current().target, slot),
                        ]}
                        onChange={(value) => {
                          setReplacements((before) => ({ ...before, [slot]: value }));
                          if (slot === "balanced" && value !== NONE && !retargetTo()) setRetargetTo(value);
                        }}
                      />
                    </Field>
                  )}
                </For>
              </Section>
            </Show>
            <Section title={t().delEffects}>
              {fact("messages", t().delChats({ p: current().data.usage.chats }))}
              <Show when={current().data.usage.projects.length > 0}>
                {fact(
                  "folders",
                  t().delProjects({
                    p: current()
                      .data.usage.projects.map((entry) => entry.name)
                      .join(", "),
                  }),
                )}
              </Show>
              <Show when={current().data.usage.workflows.length > 0}>
                {fact(
                  "route",
                  t().delWorkflows({
                    p: current()
                      .data.usage.workflows.map((entry) => entry.name)
                      .join(", "),
                  }),
                )}
              </Show>
              <Show when={current().data.usage.budgetRules.length > 0}>
                {fact(
                  "gauge",
                  t().delBudgets({
                    p: current()
                      .data.usage.budgetRules.map((entry) => entry.label)
                      .join(", "),
                  }),
                )}
              </Show>
              {fact("api", t().delRunning)}
            </Section>
            <Show when={hasReferences(current().data)}>
              <Field label={t().delMove} hint={t().delMoveHelp}>
                <Check switch label={retarget() ? t().on : t().off} checked={retarget()} disabled={busy()} onChange={setRetarget} />
              </Field>
              <Show when={retarget()}>
                <Field label={t().delRefTarget}>
                  <Select
                    placeholder={t().delPick}
                    value={retargetTo() ?? undefined}
                    disabled={busy()}
                    options={candidates(current().data, current().target, null)}
                    onChange={setRetargetTo}
                  />
                </Field>
              </Show>
            </Show>
          </>
        )}
      </Show>
      <Show when={error()}>
        <Notice tone="bad" title={t().saveFailed}>
          {error()}
        </Notice>
      </Show>
    </Dialog>
  );
}

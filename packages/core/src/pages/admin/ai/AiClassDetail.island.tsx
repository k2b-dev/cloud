import { AiModelCard, type AiModelCardStop, AiModelIcon, aiModelDisplayIcon } from "@k2b/cloud/ai/ui";
import {
  AI_MODEL_CLASSES,
  AiAssignmentSchema,
  type AiModel,
  type AiModelAssignment,
  type AiModelClass,
  type AiModelSlot,
  type AiModelVariant,
  aiModelClassFallbackChain,
} from "@k2b/cloud/shared";
import { Button, NoticeCard, RichSelect, StatusBadge, useLocale } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { openAddProvider } from "./AiAreaActions.island";
import { type AiAdminConflict, aiAdminApi, asAiConflict, readAiAdmin, reloadAiArea } from "./client";
import { aiAreaMessages } from "./messages";
import { type AiProviderState, aiClassSubtitle, aiSlotLabel, aiVariantName, formatAiTime, isAiModelClass } from "./presentation";
import { effortLabel } from "./variants";

type Assignment = {
  slot: AiModelSlot;
  variantId: string | null;
  revision: number;
  updatedAt: string;
  updatedBy: string | null;
  fallbackChain: AiModelClass[];
  effectiveClass: AiModelClass | null;
  usage: { class: string; app: string | null; task: string; calls: number }[];
};
type Provider = { id: string; label: string; state: AiProviderState };
const NONE = "__none";

/** A5 detail: which model a class or tool uses, what happens when it is empty, who uses it, and what people see. */
export default function AiClassDetail(props: {
  slot: AiModelSlot;
  assignment: Assignment;
  providers: Provider[];
  models: AiModel[];
  variants: AiModelVariant[];
  assignments: Record<AiModelSlot, { variantId: string | null }>;
  effective: Record<AiModelClass, { class: AiModelClass | null; variantId: string | null }>;
  appNames: Record<string, string>;
}) {
  const locale = useLocale();
  const t = () => aiAreaMessages.resolve([locale()]).t;
  const [assignment, setAssignment] = createSignal(props.assignment);
  const [value, setValue] = createSignal(props.assignment.variantId);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const [conflict, setConflict] = createSignal<AiAdminConflict<AiModelAssignment> | null>(null);
  const modelClass = (): AiModelClass | null => (isAiModelClass(props.slot) ? props.slot : null);
  const isClass = () => modelClass() !== null;

  const find = (variantId: string | null | undefined) => {
    const variant = props.variants.find((candidate) => candidate.id === variantId);
    const model = variant ? props.models.find((candidate) => candidate.id === variant.modelId) : undefined;
    const provider = model ? props.providers.find((candidate) => candidate.id === model.providerId) : undefined;
    return variant && model && provider ? { variant, model, provider } : null;
  };
  const name = (variantId: string | null | undefined) => {
    const found = find(variantId);
    return found ? aiVariantName(found.model, found.variant) : t().clsUnassigned;
  };

  /** Only models that can fill this slot: chat for classes, image capability for the image tool, transcription for audio. */
  const items = () =>
    props.variants.flatMap((variant) => {
      const model = props.models.find((candidate) => candidate.id === variant.modelId);
      const provider = model ? props.providers.find((candidate) => candidate.id === model.providerId) : undefined;
      if (!model || !provider || !model.enabled) return [];
      if (props.slot === "audio" ? model.kind !== "transcription" : model.kind !== "chat") return [];
      if (props.slot === "vision" && !model.capabilities.includes("vision")) return [];
      const others = (Object.keys(props.assignments) as AiModelSlot[]).filter(
        (slot) => slot !== props.slot && props.assignments[slot]?.variantId === variant.id,
      );
      const issue = provider.state === "unreachable" || provider.state === "badkey" ? provider.state : null;
      return [
        {
          value: variant.id,
          label: aiVariantName(model, variant),
          description: [
            variant.reasoningEffort ? t().variantFallback({ p: effortLabel(t(), variant.reasoningEffort) }) : "",
            others.map((slot) => aiSlotLabel(t(), slot)).join(", "),
            issue === "unreachable" ? t().stUnreach : issue === "badkey" ? t().stBadKey : "",
          ]
            .filter(Boolean)
            .join(" · "),
          section: provider.id,
          visual: () => <AiModelIconFor model={model} provider={provider} />,
        },
      ];
    });
  const fallback = () => {
    const current = modelClass();
    return current ? props.effective[current]?.class : null;
  };
  const chain = () => {
    const current = modelClass();
    return current ? [current, ...aiModelClassFallbackChain(current)] : [];
  };
  const emptyLabel = () => {
    const current = modelClass();
    if (!current) return t().off;
    const next = aiModelClassFallbackChain(current).find((entry) => props.assignments[entry]?.variantId);
    return next ? `${t().clsUnassigned} · ${t().clsThenUses({ p: aiSlotLabel(t(), next) })}` : `${t().clsUnassigned} · ${t().clsThenNone}`;
  };

  const save = async (variantId: string | null, revision = assignment().revision) => {
    setSaving(true);
    setError("");
    setConflict(null);
    try {
      await readAiAdmin(
        await aiAdminApi.assignments[":slot"].$put({ param: { slot: props.slot }, json: { revision, variantId } }),
        t().saveFailed,
      );
      reloadAiArea();
    } catch (failure) {
      const conflict = asAiConflict(failure, AiAssignmentSchema);
      if (conflict) setConflict(conflict);
      else setError(failure instanceof Error ? failure.message : t().saveFailed);
      setSaving(false);
    }
  };

  const stops = (): AiModelCardStop[] =>
    AI_MODEL_CLASSES.flatMap((entry) => {
      const id = entry === props.slot ? value() : props.assignments[entry]?.variantId;
      const found = find(id);
      return found ? [{ class: entry, name: found.model.label, icon: aiModelDisplayIcon(found.model.icon, found.provider) }] : [];
    });
  const usageRows = () => assignment().usage.filter((row) => row.class === props.slot);
  const nothing = () => props.models.length === 0;

  return (
    <div class="grid gap-5 px-4 pb-10">
      <p class="-mt-2 flex min-h-5 items-center gap-2 text-sm text-(--k2b-text-muted)" role="status">
        <Show when={saving()}>
          <StatusBadge tone="running" variant="dot" label={t().saving} />
        </Show>
      </p>
      <Show when={conflict()}>
        {(current) => (
          <NoticeCard
            tone="warning"
            icon="ti ti-git-merge"
            role="alert"
            title={
              current().changedBy
                ? t().conflictTitle({ name: current().changedBy!.name, time: formatAiTime(locale(), current().changedAt) })
                : t().conflictTitleUnknown
            }
            detail={t().clsConflict({ name: current().changedBy?.name ?? "", choice: name(current().current.variantId) })}
          >
            <div class="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={() => void save(value(), current().current.revision)}>
                {t().keepMine}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setAssignment({ ...assignment(), ...current().current });
                  setValue(current().current.variantId);
                  setConflict(null);
                }}
              >
                {t().takeTheirs}
              </Button>
            </div>
          </NoticeCard>
        )}
      </Show>
      <Show when={nothing()}>
        <NoticeCard tone="info" icon="ti ti-stairs" title={t().recsEmpty} detail={t().clsEmptyNote}>
          <div>
            <Button type="button" variant="ai" size="sm" onClick={openAddProvider}>
              <i class="ti ti-plus" aria-hidden="true" />
              {t().addProvider}
            </Button>
          </div>
        </NoticeCard>
      </Show>
      <Show when={isClass() && !value() && !nothing()}>
        <Show when={fallback()} fallback={<NoticeCard tone="danger" icon="ti ti-alert-triangle" title={t().clsNoneAtAll} />}>
          {(next) => (
            <NoticeCard
              tone="warning"
              icon="ti ti-arrow-down-right"
              title={t().clsFallbackNow({
                slot: aiSlotLabel(t(), props.slot),
                model: `${aiSlotLabel(t(), next())} (${name(props.effective[next()]?.variantId)})`,
              })}
            />
          )}
        </Show>
      </Show>
      <section class="grid gap-2">
        <h3 class="text-sm font-semibold">{isClass() ? t().clsModelHead : t().slotChoose}</h3>
        <RichSelect
          label={isClass() ? t().clsModelHead : t().slotChoose}
          title={aiSlotLabel(t(), props.slot)}
          placeholder={t().notSet}
          items={[{ value: NONE, label: emptyLabel(), section: "none" }, ...items()]}
          sections={[
            { id: "none", label: aiSlotLabel(t(), props.slot) },
            ...props.providers.map((provider) => ({ id: provider.id, label: provider.label })),
          ]}
          value={() => value() ?? NONE}
          disabled={saving() || nothing()}
          onValueChange={(next) => {
            const variantId = next === NONE || next === null ? null : next;
            setValue(variantId);
            void save(variantId);
          }}
        />
      </section>
      <Show when={isClass()}>
        <section class="grid gap-2">
          <h3 class="text-sm font-semibold">{t().clsFallbackHead}</h3>
          <p class="text-xs text-(--k2b-text-muted)">{t().clsFallbackRule}</p>
          <p class="flex flex-wrap items-center gap-1 text-sm">
            <For each={chain()}>
              {(entry, index) => (
                <>
                  <Show when={index() > 0}>
                    <i class="ti ti-chevron-right text-xs text-(--k2b-text-muted)" aria-hidden="true" />
                  </Show>
                  <span
                    classList={{
                      "font-semibold": index() === 0,
                      "text-(--k2b-text-muted) line-through": index() > 0 && !props.assignments[entry]?.variantId,
                    }}
                  >
                    {aiSlotLabel(t(), entry)}
                  </span>
                </>
              )}
            </For>
          </p>
        </section>
        <section class="grid gap-2">
          <h3 class="text-sm font-semibold">{t().clsUsersHead}</h3>
          <ul class="grid gap-1.5 text-sm">
            <li class="flex items-center gap-2">
              <i class="ti ti-users text-(--k2b-text-muted)" aria-hidden="true" />
              {props.slot === "balanced" ? t().clsPeopleStart : t().clsPeople}
            </li>
            <For each={usageRows()}>
              {(row) => (
                <li class="flex items-center gap-2">
                  <i class="ti ti-apps text-(--k2b-text-muted)" aria-hidden="true" />
                  {[row.app ? (props.appNames[row.app] ?? row.app) : "Cloud", row.task].join(" · ")}
                  <span class="text-xs text-(--k2b-text-muted)">{t().callsIn14Days({ p: row.calls })}</span>
                </li>
              )}
            </For>
          </ul>
        </section>
        <section class="grid gap-2">
          <h3 class="text-sm font-semibold">{t().clsPreview}</h3>
          <div class="max-w-[21.25rem] rounded-xl bg-(--k2b-surface-elevated) p-3 shadow-[0_0_0_1px_var(--k2b-border)]">
            <AiModelCard stops={stops()} value={stops().some((stop) => stop.class === modelClass()) ? modelClass() : null} preview />
          </div>
        </section>
      </Show>
      <Show when={!isClass()}>
        <p class="text-xs text-(--k2b-text-muted)">{aiClassSubtitleForTool(t(), props.slot)}</p>
      </Show>
      <Show when={error()}>
        <NoticeCard tone="danger" title={t().saveFailed} detail={error()} role="alert" />
      </Show>
    </div>
  );
}

const aiClassSubtitleForTool = (t: ReturnType<typeof aiAreaMessages.resolve>["t"], slot: AiModelSlot) =>
  slot === "vision" ? t.slotd_vision : slot === "audio" ? t.slotd_audio : isAiModelClass(slot) ? aiClassSubtitle(t, slot) : "";

const AiModelIconFor = (props: { model: AiModel; provider: Provider }) => (
  <AiModelIcon icon={aiModelDisplayIcon(props.model.icon, props.provider)} size="xs" />
);

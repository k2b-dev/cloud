import { PrincipalPicker, principalLabel } from "@k2b/cloud/access/ui";
import { AiModelIcon, aiModelDisplayIcon } from "@k2b/cloud/ai/ui";
import type { AccessEntry, Principal } from "@k2b/cloud/contracts";
import { AccessEntrySchema } from "@k2b/cloud/contracts";
import {
  type AiModel,
  type AiModelIcon as AiModelIconSetting,
  AiModelSchema,
  type AiModelSlot,
  type AiModelUsage,
  type AiModelVariant,
  type AiProvider,
  AiVariantSchema,
} from "@k2b/cloud/shared";
import {
  Button,
  ButtonLink,
  Checkbox,
  CopyButton,
  Disclosure,
  EmojiPicker,
  IconButton,
  NoticeCard,
  NumberInput,
  SegmentedControl,
  StatusBadge,
  Switch,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { z } from "zod";
import AiProviderNotice from "./AiProviderNotice.island";
import { aiAreaHref } from "./area";
import { type AiAdminConflict, aiAdminApi, asAiConflict, readAiAdmin, reloadAiArea } from "./client";
import { ConflictNotice } from "./conflict";
import { openAiDelete } from "./delete";
import { setAiDetailControls } from "./detail-controls";
import { aiAreaMessages } from "./messages";
import { type AiAreaMessages, aiProviderState, aiSlotLabel, isAiModelClass } from "./presentation";
import { effortLabel, openAiVariant } from "./variants";

type Detail = AiModel & { variants: AiModelVariant[]; access?: { entries: AccessEntry[]; revision: number } };
const DetailSchema = AiModelSchema.extend({
  variants: z.array(AiVariantSchema),
  access: z.object({ entries: z.array(AccessEntrySchema), revision: z.number() }).optional(),
});
type Grant = { principal: Principal; displayName?: string; avatarHash?: string | null };

type Draft = {
  label: string;
  description: string;
  icon: AiModelIconSetting;
  providerModel: string;
  kind: "chat" | "transcription";
  tools: boolean;
  vision: boolean;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  temperature: number | null;
  maxLoadedTools: number | null;
  maxToolRounds: number | null;
  extraBody: string;
  priced: boolean;
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  restricted: boolean;
  grants: Grant[];
};

const toDraft = (model: Detail): Draft => {
  const entries = model.access?.entries ?? [];
  return {
    label: model.label,
    description: model.description,
    icon: model.icon,
    providerModel: model.providerModel,
    kind: model.kind,
    tools: model.capabilities.includes("tools"),
    vision: model.capabilities.includes("vision"),
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    temperature: model.temperature,
    maxLoadedTools: model.maxLoadedTools,
    maxToolRounds: model.maxToolRounds,
    extraBody: model.extraBody ? JSON.stringify(model.extraBody, null, 2) : "",
    priced: Boolean(model.pricing),
    inputPerMillion: model.pricing?.inputPerMillion ?? null,
    outputPerMillion: model.pricing?.outputPerMillion ?? null,
    restricted: !entries.some((entry) => entry.principal.type === "authenticated"),
    grants: entries
      .filter((entry) => entry.principal.type !== "authenticated")
      .map((entry) => ({ principal: entry.principal, displayName: entry.displayName, avatarHash: entry.avatarHash })),
  };
};

const CONFLICT_FIELDS = [
  "label",
  "description",
  "providerModel",
  "kind",
  "tools",
  "vision",
  "contextWindow",
  "maxOutputTokens",
  "temperature",
  "maxLoadedTools",
  "maxToolRounds",
  "extraBody",
  "priced",
  "inputPerMillion",
  "outputPerMillion",
] as const;

const Section = (props: { title: string; action?: JSX.Element; description?: string; children: JSX.Element }) => (
  <section class="grid gap-3 border-t border-(--k2b-border) pt-5 first:border-t-0 first:pt-0">
    <header class="flex min-h-8 items-center justify-between gap-3">
      <h3 class="text-sm font-semibold">{props.title}</h3>
      {props.action}
    </header>
    <Show when={props.description}>
      <p class="-mt-2 text-xs text-(--k2b-text-muted)">{props.description}</p>
    </Show>
    {props.children}
  </section>
);

const readImage = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const context = canvas.getContext("2d");
      if (!context) return reject(new Error("canvas"));
      const scale = Math.max(64 / image.width, 64 / image.height);
      context.drawImage(image, (64 - image.width * scale) / 2, (64 - image.height * scale) / 2, image.width * scale, image.height * scale);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/webp", 0.85));
    };
    image.onerror = () => reject(new Error("image"));
    image.src = url;
  });

const money = (locale: string, value: number, unit: string) =>
  new Intl.NumberFormat(locale, {
    style: unit.length === 3 ? "currency" : "decimal",
    currency: unit.length === 3 ? unit : undefined,
    maximumFractionDigits: 4,
  }).format(value) + (unit.length === 3 ? "" : ` ${unit}`);

const SlotChip = (props: { t: AiAreaMessages; slot: AiModelSlot }) => (
  <StatusBadge
    tone={props.slot === "balanced" ? "info" : "neutral"}
    variant="chip"
    icon={null}
    label={isAiModelClass(props.slot) ? props.t.classWord({ p: aiSlotLabel(props.t, props.slot) }) : aiSlotLabel(props.t, props.slot)}
  />
);

/** A3: one model with its variants, what people see, prices, budget, access and the technical details. */
export default function AiModelDetail(props: {
  provider: AiProvider & { models: AiModel[] };
  model: Detail;
  usage: AiModelUsage | null;
  slots: AiModelSlot[];
  /** Which variant fills each slot, for the chips in the variant rows. */
  assignments: Partial<Record<AiModelSlot, string | null>>;
  accountingUnit: string | null;
  budgetRules: { id: string; label: string }[];
}) {
  const locale = useLocale();
  const t = () => aiAreaMessages.resolve([locale()]).t;
  const [base, setBase] = createSignal(props.model);
  const [draft, setDraft] = createSignal(toDraft(props.model));
  const [enabled, setEnabled] = createSignal(props.model.enabled);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const [jsonError, setJsonError] = createSignal("");
  const [conflict, setConflict] = createSignal<AiAdminConflict<Detail> | null>(null);
  const [emojiAnchor, setEmojiAnchor] = createSignal<HTMLElement | null>(null);
  let emojiButton: HTMLButtonElement | undefined;
  let fileInput: HTMLInputElement | undefined;

  const providerState = () => aiProviderState(props.provider);
  const audio = () => draft().kind === "transcription";
  const unit = () => props.accountingUnit ?? "EUR";
  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const dirty = () => JSON.stringify(draft()) !== JSON.stringify(toDraft(base())) || enabled() !== base().enabled;
  const providerMark = () => ({ id: props.provider.id, label: props.provider.label });

  const patchFrom = (value: Draft) => {
    let extraBody: Record<string, unknown> | null = null;
    if (value.extraBody.trim()) {
      const parsed: unknown = JSON.parse(value.extraBody);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError("object");
      extraBody = parsed as Record<string, unknown>;
    }
    return {
      label: value.label.trim(),
      description: value.description.trim(),
      icon: value.icon,
      providerModel: value.providerModel.trim(),
      kind: value.kind,
      capabilities:
        value.kind === "transcription"
          ? (["transcription"] as ("tools" | "vision" | "transcription")[])
          : ([...(value.tools ? ["tools"] : []), ...(value.vision ? ["vision"] : [])] as ("tools" | "vision" | "transcription")[]),
      contextWindow: value.contextWindow,
      maxOutputTokens: value.maxOutputTokens,
      temperature: value.temperature,
      maxLoadedTools: value.maxLoadedTools,
      maxToolRounds: value.maxToolRounds,
      extraBody,
      pricing:
        value.kind === "chat" && value.priced && value.inputPerMillion !== null && value.outputPerMillion !== null
          ? { inputPerMillion: value.inputPerMillion, outputPerMillion: value.outputPerMillion }
          : null,
      enabled: enabled(),
    };
  };

  const accessDraft = (value: Draft, current: Detail) => {
    const before = toDraft(current);
    if (before.restricted === value.restricted && JSON.stringify(before.grants) === JSON.stringify(value.grants)) return undefined;
    return {
      expectedRevision: current.access?.revision ?? null,
      entries: value.restricted
        ? value.grants.map((grant) => ({ principal: grant.principal, permission: "read" as const }))
        : [{ principal: { type: "authenticated" } as Principal, permission: "read" as const }],
    };
  };

  const save = async (value = draft(), current = base()) => {
    setError("");
    setJsonError("");
    let patch: ReturnType<typeof patchFrom>;
    try {
      patch = patchFrom(value);
    } catch {
      setJsonError(t().extraParamsInvalid);
      return;
    }
    setSaving(true);
    try {
      const access = accessDraft(value, current);
      await readAiAdmin<AiModel>(
        await aiAdminApi.models[":id"].$patch({
          param: { id: current.id },
          json: { revision: current.revision, ...patch, ...(access ? { access } : {}) },
        }),
        t().saveFailed,
      );
      toast.success(t().saved);
      reloadAiArea();
    } catch (failure) {
      const conflict = asAiConflict(failure, DetailSchema);
      if (conflict) setConflict(conflict);
      else setError(failure instanceof Error ? failure.message : t().saveFailed);
      setSaving(false);
    }
  };

  createEffect(() =>
    setAiDetailControls({
      enabled: { value: enabled(), onChange: setEnabled },
      test: {
        label: t().testModel,
        busy: false,
        disabled: providerState() !== "ok" || audio(),
        run: () => void aiAdminApi.providers[":id"].test.$post({ param: { id: props.provider.id } }).then(() => reloadAiArea()),
      },
      save: { dirty: dirty() && !conflict(), saving: saving(), run: () => void save() },
    }),
  );
  onCleanup(() => setAiDetailControls(null));

  const variants = () => base().variants;
  const variantSlots = (variantId: string) =>
    (Object.keys(props.assignments) as AiModelSlot[]).filter((slot) => props.assignments[slot] === variantId);
  const priceText = (pricing: { inputPerMillion: number; outputPerMillion: number } | null) =>
    pricing ? `${money(locale(), pricing.inputPerMillion, unit())} / ${money(locale(), pricing.outputPerMillion, unit())}` : t().inherited;
  const example = () => {
    const value = draft();
    if (value.inputPerMillion === null || value.outputPerMillion === null) return "";
    return t().example({ p: money(locale(), value.inputPerMillion * 0.01 + value.outputPerMillion * 0.002, unit()) });
  };

  return (
    <div class="grid gap-5 px-4 pb-10">
      <AiProviderNotice
        providerId={props.provider.id}
        providerLabel={props.provider.label}
        state={providerState()}
        statusMessage={props.provider.statusMessage}
        checkedAt={props.provider.statusCheckedAt}
      />
      <Show when={conflict()}>
        {(current) => (
          <ConflictNotice<Draft>
            conflict={current()}
            fields={CONFLICT_FIELDS.map((key) => ({
              key,
              label: {
                label: t().displayName,
                description: t().description,
                providerModel: t().providerModelId,
                kind: t().kind,
                tools: t().capTools,
                vision: t().capVision,
                contextWindow: t().ctx,
                maxOutputTokens: t().maxOut,
                temperature: t().temperature,
                maxLoadedTools: t().toolLoaded,
                maxToolRounds: t().toolRounds,
                extraBody: t().extraParams,
                priced: t().setPrices,
                inputPerMillion: t().inPrice,
                outputPerMillion: t().outPrice,
              }[key],
            }))}
            base={toDraft(base())}
            mine={draft()}
            theirs={toDraft(current().current)}
            busy={saving()}
            onMerge={(merged) => {
              const theirs = current().current;
              setConflict(null);
              setBase(theirs);
              setDraft(merged);
              void save(merged, theirs);
            }}
            onDiscard={() => {
              setConflict(null);
              setBase(current().current);
              setDraft(toDraft(current().current));
              setEnabled(current().current.enabled);
            }}
          />
        )}
      </Show>
      <p class="-mt-2 font-mono text-xs text-(--k2b-text-muted)">
        {base().providerModel} · {props.provider.label}
      </p>
      <fieldset class="grid gap-6" disabled={saving()}>
        <Section
          title={t().usedAs}
          action={
            <ButtonLink variant="ghost" size="sm" href={aiAreaHref({ sec: "classes" })}>
              {t().editInRecs}
              <i class="ti ti-arrow-right" aria-hidden="true" />
            </ButtonLink>
          }
        >
          <Show when={props.slots.length} fallback={<p class="text-sm text-(--k2b-text-muted)">{t().usedAsNone}</p>}>
            <div class="flex flex-wrap gap-1.5">
              <For each={props.slots}>{(slot) => <SlotChip t={t()} slot={slot} />}</For>
            </div>
          </Show>
        </Section>

        <Show when={!audio()}>
          <Section
            title={t().variants}
            description={t().variantsSub}
            action={
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => openAiVariant({ model: base(), provider: props.provider })}
              >
                <i class="ti ti-plus" aria-hidden="true" />
                {t().addVariant}
              </Button>
            }
          >
            <ul class="grid">
              <For each={variants()}>
                {(variant) => (
                  <li>
                    <button
                      type="button"
                      class="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-(--k2b-surface-muted) focus-visible:outline-2 focus-visible:outline-(--k2b-focus-ring) sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
                      onClick={() => openAiVariant({ model: base(), provider: props.provider, variant })}
                    >
                      <span class="grid min-w-0">
                        <span class="text-sm font-medium">{variant.label}</span>
                        <span class="truncate font-mono text-xs text-(--k2b-text-muted)">{variant.id}</span>
                      </span>
                      <span class="hidden text-xs text-(--k2b-text-secondary) sm:inline-flex sm:items-center sm:gap-1">
                        <i class="ti ti-brain" aria-hidden="true" />
                        {effortLabel(t(), variant.reasoningEffort)}
                        {variant.extraBody ? " · JSON" : ""}
                      </span>
                      <span class="hidden text-xs text-(--k2b-text-muted) sm:inline">
                        {priceText(variant.pricing)}
                        {variant.maxOutputTokens ? ` · ${variant.maxOutputTokens.toLocaleString(locale())}` : ""}
                      </span>
                      <span class="inline-flex flex-wrap items-center justify-end gap-1.5">
                        <For each={variantSlots(variant.id)}>{(slot) => <SlotChip t={t()} slot={slot} />}</For>
                        <Show when={!variant.showInPicker}>
                          <StatusBadge tone="neutral" variant="chip" icon="ti ti-eye-off" label={t().shownNo} />
                        </Show>
                        <i class="ti ti-pencil text-(--k2b-text-muted)" aria-hidden="true" />
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Section>
        </Show>

        <Section title={t().forPeople}>
          <TextInput label={t().displayName} value={() => draft().label} onValueChange={(label) => update({ label })} required />
          <div class="grid gap-1.5">
            <span class="text-sm font-medium">{t().iconLabel}</span>
            <div class="flex flex-wrap items-center gap-3">
              <AiModelIcon icon={aiModelDisplayIcon(draft().icon, providerMark())} size="md" />
              <SegmentedControl
                ariaLabel={t().iconLabel}
                size="sm"
                value={() => draft().icon.kind}
                onValueChange={(kind) => {
                  if (kind === "provider") update({ icon: { kind: "provider" } });
                  if (kind === "emoji") setEmojiAnchor(emojiButton ?? null);
                  if (kind === "image") fileInput?.click();
                }}
                options={[
                  { value: "provider", label: t().iconProvider },
                  { value: "emoji", label: t().iconEmoji },
                  { value: "image", label: t().iconUpload },
                ]}
              />
              <Button
                ref={emojiButton}
                type="button"
                variant="secondary"
                size="sm"
                aria-haspopup="dialog"
                aria-expanded={emojiAnchor() !== null}
                class={draft().icon.kind === "emoji" ? "" : "invisible"}
                onClick={(event) => setEmojiAnchor(emojiAnchor() ? null : event.currentTarget)}
              >
                <i class="ti ti-mood-smile" aria-hidden="true" />
                {t().chooseEmoji}
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                class="hidden"
                onChange={async (event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (!file) return;
                  try {
                    update({ icon: { kind: "image", dataUrl: await readImage(file) } });
                  } catch {
                    setError(t().iconUploadFailed);
                  }
                }}
              />
              <EmojiPicker.Popover
                anchor={emojiAnchor()}
                onPick={(emoji) => update({ icon: { kind: "emoji", emoji } })}
                onClose={() => setEmojiAnchor(null)}
              />
            </div>
            <p class="text-xs text-(--k2b-text-muted)">{t().iconHelp}</p>
          </div>
          <TextInput
            label={t().description}
            multiline
            lines={2}
            maxLength={160}
            value={() => draft().description}
            onValueChange={(description) => update({ description })}
            description={`${t().descHelp} ${draft().description.length}/160`}
            error={() => (!audio() && !draft().description.trim() ? t().noSubtitle : undefined)}
          />
        </Section>

        <Section title={t().prices} description={audio() ? undefined : t().pricesSub}>
          <Show when={!audio()} fallback={<p class="text-sm text-(--k2b-text-muted)">{t().audioNoPrice}</p>}>
            <Switch label={t().setPrices} value={() => draft().priced} onValueChange={(priced) => update({ priced })} />
            <Show when={draft().priced} fallback={<NoticeCard tone="warning" icon="ti ti-alert-triangle" title={t().unpricedWarn} />}>
              <div class="grid gap-3 sm:grid-cols-2">
                <NumberInput
                  label={t().inPrice}
                  value={() => draft().inputPerMillion}
                  onValueChange={(inputPerMillion) => update({ inputPerMillion })}
                  min={0}
                  step={0.01}
                  suffix={unit()}
                />
                <NumberInput
                  label={t().outPrice}
                  value={() => draft().outputPerMillion}
                  onValueChange={(outputPerMillion) => update({ outputPerMillion })}
                  min={0}
                  step={0.01}
                  suffix={unit()}
                />
              </div>
              <p class="text-xs text-(--k2b-text-muted)">{example()}</p>
            </Show>
          </Show>
        </Section>

        <Show when={!audio()}>
          <Section
            title={t().budget}
            action={
              <ButtonLink variant="ghost" size="sm" href={aiAreaHref({ sec: "budgets" })}>
                {t().openBudgets}
                <i class="ti ti-arrow-right" aria-hidden="true" />
              </ButtonLink>
            }
          >
            <p class="text-sm text-(--k2b-text-secondary)">
              {t().budgetRules({ p: props.budgetRules.length })} {props.budgetRules.map((rule) => rule.label).join(" · ")}
            </p>
            <Show when={(props.usage?.peopleAtLimit ?? 0) > 0}>
              <NoticeCard tone="warning" icon="ti ti-gauge" title={t().atLimit({ p: props.usage?.peopleAtLimit ?? 0 })} />
            </Show>
          </Section>
        </Show>

        <Section title={t().access} description={t().accessSub}>
          <SegmentedControl
            ariaLabel={t().access}
            value={() => (draft().restricted ? "restricted" : "all")}
            onValueChange={(value) => update({ restricted: value === "restricted" })}
            options={[
              { value: "all", label: t().accessAll },
              { value: "restricted", label: t().accessRestricted },
            ]}
          />
          <Show when={draft().restricted}>
            <div class="grid max-w-md gap-2">
              <div class="flex flex-wrap gap-1.5">
                <For each={draft().grants}>
                  {(grant, index) => (
                    <span class="inline-flex items-center gap-1 rounded-full bg-(--k2b-surface-muted) py-0.5 ps-2.5 pe-1 text-sm">
                      {principalLabel(grant, locale())}
                      <IconButton
                        type="button"
                        variant="ghost"
                        size="sm"
                        label={t().delete}
                        onClick={() => update({ grants: draft().grants.filter((_, position) => position !== index()) })}
                      >
                        <i class="ti ti-x" aria-hidden="true" />
                      </IconButton>
                    </span>
                  )}
                </For>
              </div>
              <PrincipalPicker
                existing={draft().grants.map((grant) => grant.principal)}
                placeholder={t().addPrincipal}
                allowServiceAccounts
                onSelect={(principal, display) =>
                  update({ grants: [...draft().grants, { principal, displayName: display.displayName, avatarHash: display.avatarHash }] })
                }
              />
            </div>
          </Show>
        </Section>

        <Section title={t().modelSec}>
          <div class="grid gap-4 sm:grid-cols-2">
            <TextInput
              label={t().providerModelId}
              monospace
              value={() => draft().providerModel}
              onValueChange={(providerModel) => update({ providerModel })}
              required
            />
            <SegmentedControl
              label={t().kind}
              value={() => draft().kind}
              onValueChange={(kind) => update({ kind })}
              options={[
                { value: "chat", label: t().kindChat, icon: "ti ti-message-2" },
                { value: "transcription", label: t().kindAudio, icon: "ti ti-microphone" },
              ]}
            />
            <Show when={!audio()}>
              <div class="grid gap-2 sm:col-span-2">
                <span class="text-sm font-medium">{t().caps}</span>
                <div class="flex flex-wrap gap-4">
                  <Checkbox label={t().capTools} value={() => draft().tools} onValueChange={(tools) => update({ tools })} />
                  <Checkbox label={t().capVision} value={() => draft().vision} onValueChange={(vision) => update({ vision })} />
                </div>
                <p class="text-xs text-(--k2b-text-muted)">{t().capsHelp}</p>
              </div>
              <NumberInput
                label={t().ctx}
                value={() => draft().contextWindow}
                onValueChange={(contextWindow) => update({ contextWindow })}
                min={1}
                placeholder={t().providerDefault}
                suffix={t().tokens}
              />
              <NumberInput
                label={t().maxOut}
                value={() => draft().maxOutputTokens}
                onValueChange={(maxOutputTokens) => update({ maxOutputTokens })}
                min={1}
                placeholder={t().providerDefault}
                suffix={t().tokens}
              />
            </Show>
          </div>
        </Section>

        <Disclosure summary={t().advanced} surface="plain">
          <div class="grid gap-4 sm:grid-cols-2">
            <Show when={!audio()}>
              <NumberInput
                label={t().temperature}
                description={t().temperatureHelp}
                value={() => draft().temperature}
                onValueChange={(temperature) => update({ temperature })}
                min={0}
                max={2}
                step={0.1}
                placeholder={t().providerDefault}
              />
            </Show>
            <div class="grid gap-1.5">
              <span class="text-sm font-medium">{t().modelId}</span>
              <span class="inline-flex items-center gap-2 font-mono text-sm">
                {base().id}
                <CopyButton value={base().id} label={t().copy} />
              </span>
              <p class="text-xs text-(--k2b-text-muted)">{t().modelIdHelp}</p>
            </div>
            <Show when={!audio()}>
              <NumberInput
                label={t().toolLoaded}
                value={() => draft().maxLoadedTools}
                onValueChange={(maxLoadedTools) => update({ maxLoadedTools })}
                min={0}
                placeholder={t().unlimited}
              />
              <NumberInput
                label={t().toolRounds}
                value={() => draft().maxToolRounds}
                onValueChange={(maxToolRounds) => update({ maxToolRounds })}
                min={0}
                placeholder={t().unlimited}
              />
              <TextInput
                class="sm:col-span-2"
                label={t().extraParams}
                multiline
                monospace
                lines={3}
                value={() => draft().extraBody}
                onValueChange={(extraBody) => update({ extraBody })}
                placeholder='{ "top_p": 0.9 }'
                description={t().extraParamsHelp}
                error={jsonError}
              />
            </Show>
          </div>
        </Disclosure>
      </fieldset>
      <Show when={error()}>
        <NoticeCard tone="danger" title={t().saveFailed} detail={error()} role="alert" />
      </Show>
      <div class="mt-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          class="text-(--k2b-danger-text)"
          disabled={saving()}
          onClick={() => openAiDelete({ kind: "model", model: base(), provider: props.provider })}
        >
          <i class="ti ti-trash" aria-hidden="true" />
          {t().deleteModel}
        </Button>
      </div>
    </div>
  );
}

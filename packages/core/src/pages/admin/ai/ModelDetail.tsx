import { PrincipalPicker, principalLabel } from "@k2b/cloud/access/ui";
import type { AccessEntry, Principal } from "@k2b/cloud/contracts";
import { AccessEntrySchema } from "@k2b/cloud/contracts";
import {
  type AiModel,
  AiModelIconSchema,
  type AiModelIcon as AiModelIconSetting,
  AiModelSchema,
  type AiModelSlot,
  type AiModelUsage,
  type AiModelVariant,
  type AiProvider,
  AiVariantSchema,
} from "@k2b/cloud/shared";
import { EmojiPicker } from "@k2b/ui";
import {
  Bar,
  Button,
  Cells,
  Check,
  Choice,
  Disclosure,
  Facts,
  Field,
  ImageInput,
  Inline,
  Input,
  Menu,
  Notice,
  Pane,
  Popover,
  Row,
  Section,
  Table,
  Text,
  useLocale,
  useToast,
} from "@k2b/ui/v2";
import { createSignal, For, Show } from "solid-js";
import { z } from "zod";
import { aiAreaHref } from "./area";
import { type AiAdminConflict, aiAdminApi, asAiConflict, readAiAdmin, reloadAiArea } from "./client";
import { ConflictNotice } from "./conflict";
import { aiAreaMessages } from "./messages";
import { type AiAreaMessages, aiProviderState, aiSlotLabel, isAiModelClass } from "./presentation";
import { AiProviderNotice } from "./provider-notice";
import { effortLabel } from "./variants";

export type AiModelDetailData = AiModel & { variants: AiModelVariant[]; access?: { entries: AccessEntry[]; revision: number } };
const DetailSchema = AiModelSchema.extend({
  variants: z.array(AiVariantSchema),
  access: z.object({ entries: z.array(AccessEntrySchema), revision: z.number() }).optional(),
});
type Grant = { principal: Principal; displayName?: string; avatarHash?: string | null };

type Draft = {
  enabled: boolean;
  label: string;
  description: string;
  icon: AiModelIconSetting;
  providerModel: string;
  kind: AiModel["kind"];
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

const toDraft = (model: AiModelDetailData): Draft => {
  const entries = model.access?.entries ?? [];
  return {
    enabled: model.enabled,
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
  "enabled",
  "icon",
  "restricted",
  "grants",
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

/** An uploaded icon becomes a 64 px picture (the people's chooser shows it at most that large). */
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

export const aiMoney = (locale: string, value: number, unit: string, digits = 4) =>
  new Intl.NumberFormat(locale, {
    style: unit.length === 3 ? "currency" : "decimal",
    currency: unit.length === 3 ? unit : undefined,
    maximumFractionDigits: digits,
  }).format(value) + (unit.length === 3 ? "" : ` ${unit}`);

const emojiOf = (icon: AiModelIconSetting) => (icon.kind === "emoji" ? icon.emoji : "✨");
const imageOf = (icon: AiModelIconSetting) => (icon.kind === "image" && icon.dataUrl ? icon.dataUrl : null);
const numberText = (value: number | null) => (value === null ? "" : String(value));
const numberOf = (value: string) => (value.trim() === "" ? null : Number(value));
const slotName = (t: AiAreaMessages, slot: AiModelSlot) =>
  isAiModelClass(slot) ? t.classWord({ p: aiSlotLabel(t, slot) }) : aiSlotLabel(t, slot);

/**
 * A3: one model as the detail beside its provider's models: what it did in the last 14 days, then its variants, what
 * people see, prices, budget, access and the technical details. "Speichern" in its head saves all of it with the
 * revision it was read at; someone else's save becomes a choice per field.
 */
export default function ModelDetail(props: {
  provider: AiProvider & { models: AiModel[] };
  model: AiModelDetailData;
  usage: AiModelUsage | null;
  slots: AiModelSlot[];
  /** Which variant fills each slot, for the classes a variant row names. */
  assignments: Partial<Record<AiModelSlot, string | null>>;
  accountingUnit: string | null;
  back: { label: string; href: string };
  onVariant: (variant?: AiModelVariant) => void;
  onDelete: () => void;
}) {
  const locale = useLocale();
  const t = () => aiAreaMessages.resolve([locale()]).t;
  const toast = useToast();
  const [base, setBase] = createSignal(props.model);
  const [draft, setDraft] = createSignal(toDraft(props.model));
  const [saving, setSaving] = createSignal(false);
  const [testing, setTesting] = createSignal(false);
  const [error, setError] = createSignal("");
  const [jsonError, setJsonError] = createSignal("");
  const [conflict, setConflict] = createSignal<AiAdminConflict<AiModelDetailData> | null>(null);

  const providerState = () => aiProviderState(props.provider);
  const audio = () => draft().kind === "transcription" || draft().kind === "live-transcription";
  const chat = () => draft().kind === "chat";
  const limitsMissing = () => {
    const value = draft();
    if (value.kind !== "chat") return false;
    const priced = value.priced && ((value.inputPerMillion ?? 0) > 0 || (value.outputPerMillion ?? 0) > 0);
    const missing = (output: number | null | undefined) =>
      !value.contextWindow || !(output ?? value.maxOutputTokens ?? base().outputTokenLimit);
    return (
      (priced && missing(null)) ||
      base().variants.some(
        (variant) =>
          (variant.pricing ? variant.pricing.inputPerMillion > 0 || variant.pricing.outputPerMillion > 0 : priced) &&
          missing(variant.maxOutputTokens),
      )
    );
  };
  const unit = () => props.accountingUnit ?? "EUR";
  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const dirty = () => JSON.stringify(draft()) !== JSON.stringify(toDraft(base()));

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
        value.kind === "transcription" || value.kind === "live-transcription"
          ? [value.kind]
          : [...(value.kind === "chat" && value.tools ? ["tools" as const] : []), ...(value.vision ? ["vision" as const] : [])],
      contextWindow: value.contextWindow,
      maxOutputTokens: value.kind === "decision" ? null : value.maxOutputTokens,
      temperature: value.kind === "decision" ? null : value.temperature,
      maxLoadedTools: value.kind === "decision" ? null : value.maxLoadedTools,
      maxToolRounds: value.kind === "decision" ? null : value.maxToolRounds,
      extraBody: value.kind === "decision" ? null : extraBody,
      pricing:
        (value.kind === "chat" || value.kind === "decision") &&
        value.priced &&
        value.inputPerMillion !== null &&
        value.outputPerMillion !== null
          ? { ...base().pricing, inputPerMillion: value.inputPerMillion, outputPerMillion: value.outputPerMillion }
          : null,
      enabled: value.enabled,
    };
  };

  const accessDraft = (value: Draft, current: AiModelDetailData) => {
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
      toast(t().saved, { status: "ok" });
      reloadAiArea();
    } catch (failure) {
      const found = asAiConflict(failure, DetailSchema);
      if (found) setConflict(found);
      else setError(failure instanceof Error ? failure.message : t().saveFailed);
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    await aiAdminApi.providers[":id"].test.$post({ param: { id: props.provider.id } }).catch(() => null);
    reloadAiArea();
  };

  const variantSlots = (variantId: string) =>
    (Object.keys(props.assignments) as AiModelSlot[]).filter((slot) => props.assignments[slot] === variantId);
  const priceText = (pricing: { inputPerMillion: number; outputPerMillion: number } | null) =>
    pricing
      ? `${aiMoney(locale(), pricing.inputPerMillion, unit())} / ${aiMoney(locale(), pricing.outputPerMillion, unit())}`
      : t().inherited;
  const example = () => {
    const value = draft();
    if (value.inputPerMillion === null || value.outputPerMillion === null) return "";
    return t().example({ p: aiMoney(locale(), value.inputPerMillion * 0.01 + value.outputPerMillion * 0.002, unit()) });
  };
  const stats = () => props.usage?.stats;
  const unpricedChat = () =>
    chat() &&
    (!draft().priced ||
      draft().inputPerMillion === null ||
      draft().outputPerMillion === null ||
      !((draft().inputPerMillion ?? 0) > 0 || (draft().outputPerMillion ?? 0) > 0));
  const kinds = () => [
    { value: "chat", label: t().kindChat },
    ...(props.provider.type === "openai-compatible" ? [{ value: "decision", label: t().kindDecision }] : []),
    // Audio is unavailable on providers without a data-protection commitment.
    ...(props.provider.dataBoundary === "restricted"
      ? []
      : [
          { value: "transcription", label: t().kindAudio },
          { value: "live-transcription", label: t().kindLiveAudio },
        ]),
  ];
  // an upload is chosen before its file: the choice shows the picker while the draft keeps the icon it had
  const [iconChoice, setIconChoice] = createSignal<AiModelIconSetting["kind"] | null>(null);
  const iconKind = () => iconChoice() ?? draft().icon.kind;

  return (
    <Pane
      detail
      label={props.model.label}
      back={props.back}
      scrollKey="admin-ai-model"
      head={
        <Bar
          start={
            // slot for #4208/#4223 (DP): the tinted object head (ObjectHead, #4360) with the model's mark (its picture, or its kind's symbol in its provider's colour); the name stands in
            <Text type="body">{props.model.label}</Text>
          }
          end={
            <>
              <Menu
                label={t().moreActions}
                items={[
                  {
                    label: t().testModel,
                    icon: "player-play",
                    disabled: providerState() !== "ok" || !chat() || saving() || testing(),
                    onClick: () => void test(),
                  },
                  { label: t().deleteModel, icon: "trash", danger: true, disabled: saving(), onClick: props.onDelete },
                ]}
              />
              <Button
                variant="primary"
                icon="check"
                keep
                busy={saving()}
                disabled={!dirty() || Boolean(conflict())}
                onClick={() => void save()}
              >
                {t().save}
              </Button>
            </>
          }
        />
      }
    >
      <AiProviderNotice
        providerId={props.provider.id}
        providerLabel={props.provider.label}
        state={providerState()}
        status={props.provider.status}
        statusCode={props.provider.statusCode}
        statusMessage={props.provider.statusMessage}
        checkedAt={props.provider.statusCheckedAt}
      />
      {/* what the model did in the last 14 days, from the usage the page reads (identity B: key facts of the open object) */}
      <Cells>
        <Cells.Cell
          icon="message-2"
          label={t().answers14d}
          value={(stats()?.answers14d ?? 0).toLocaleString(locale())}
          meta={t().nChats({ p: (props.usage?.chats ?? 0).toLocaleString(locale()) })}
        />
        <Cells.Cell
          icon="coin"
          label={t().costPerAnswer}
          value={stats()?.avgCostPerAnswer != null ? aiMoney(locale(), stats()!.avgCostPerAnswer!, unit()) : t().noDataShort}
          meta={draft().priced ? priceText(base().pricing) : t().noPrices}
        />
        <Cells.Cell
          icon="clock"
          label={t().answerTime}
          value={
            stats()?.avgSecondsPerAnswer != null
              ? t().seconds({ p: stats()!.avgSecondsPerAnswer!.toLocaleString(locale(), { maximumFractionDigits: 1 }) })
              : t().noDataShort
          }
          meta={props.model.providerModel}
        />
      </Cells>
      <Show when={conflict()}>
        {(current) => (
          <ConflictNotice<Draft>
            conflict={current()}
            fields={CONFLICT_FIELDS.map((key) => ({
              key,
              format:
                key === "icon"
                  ? (value: unknown) => {
                      const icon = AiModelIconSchema.parse(value);
                      return icon.kind === "emoji" ? icon.emoji : icon.kind === "image" ? t().iconUpload : t().iconProvider;
                    }
                  : key === "grants"
                    ? (value: unknown) =>
                        z
                          .array(AccessEntrySchema.pick({ principal: true, displayName: true, avatarHash: true }))
                          .parse(value)
                          .map((grant) => principalLabel(grant, locale()))
                          .join(", ")
                    : key === "restricted"
                      ? (value: unknown) => (value ? t().accessRestricted : t().accessAll)
                      : key === "enabled"
                        ? (value: unknown) => (value ? t().active : t().disabled)
                        : undefined,
              label: {
                enabled: t().enable,
                icon: t().iconLabel,
                restricted: t().accessRestricted,
                grants: t().access,
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
              const theirs = current().current;
              setConflict(null);
              setBase(theirs);
              setDraft(toDraft(theirs));
            }}
          />
        )}
      </Show>
      <Show when={error()}>
        <Notice tone="bad" title={t().saveFailed}>
          {error()}
        </Notice>
      </Show>

      <Section
        icon="stairs-up"
        title={t().usedAs}
        actions={[{ label: t().editInRecs, href: aiAreaHref({ sec: "classes" }), forward: true }]}
      >
        <Text muted={props.slots.length === 0}>
          {props.slots.length ? props.slots.map((slot) => slotName(t(), slot)).join(" · ") : t().usedAsNone}
        </Text>
      </Section>

      <Show when={chat()}>
        <Section
          icon="versions"
          title={t().variants}
          count={base().variants.length}
          summary={t().variantsSub}
          actions={[{ label: t().addVariant, icon: "plus", disabled: saving(), onClick: () => props.onVariant() }]}
        >
          <Table
            label={t().variants}
            rows={base().variants}
            rowKey={(variant) => variant.id}
            open={(variant) => ({ onOpen: () => props.onVariant(variant) })}
            phone={(variant) => ({
              lines: [variant.label, `${effortLabel(t(), variant.reasoningEffort)} · ${priceText(variant.pricing)}`],
              time: variantSlots(variant.id)
                .map((slot) => aiSlotLabel(t(), slot))
                .join(", "),
            })}
            columns={[
              {
                title: t().colName,
                width: { min: 140, default: 180 },
                cell: (variant) => ({ lines: [variant.label, variant.id] }),
              },
              {
                title: t().colThinking,
                width: { min: 110, default: 130 },
                cell: (variant) => `${effortLabel(t(), variant.reasoningEffort)}${variant.extraBody ? " · JSON" : ""}`,
              },
              { title: t().colPrice, width: { min: 120, default: 150 }, drop: true, cell: (variant) => priceText(variant.pricing) },
              {
                title: t().colUse,
                cell: (variant) =>
                  [...variantSlots(variant.id).map((slot) => aiSlotLabel(t(), slot)), ...(variant.showInPicker ? [] : [t().shownNo])].join(
                    " · ",
                  ),
              },
            ]}
          />
        </Section>
      </Show>

      <Section icon="user" title={t().forPeople}>
        {/* slot for #4208/#4223 (DP): the fields of this section and of the prices become Setting rows (name left, value at a fixed width) */}
        <Field label={t().active} hint={t().activeHint}>
          <Check
            switch
            label={draft().enabled ? t().on : t().off}
            checked={draft().enabled}
            disabled={saving()}
            onChange={(enabled) => update({ enabled })}
          />
        </Field>
        <Field label={t().displayName}>
          <Input value={draft().label} disabled={saving()} onInput={(label) => update({ label })} />
        </Field>
        <Field label={t().iconLabel} hint={t().iconHelp}>
          <Choice
            name="model-icon"
            value={iconKind()}
            disabled={saving()}
            options={[
              { value: "provider", label: t().iconProvider },
              { value: "emoji", label: t().iconEmoji },
              { value: "image", label: t().iconUpload },
            ]}
            onChange={(kind) => {
              setIconChoice(kind === "image" ? "image" : null);
              if (kind === "provider") update({ icon: { kind: "provider" } });
              if (kind === "emoji" && draft().icon.kind !== "emoji") update({ icon: { kind: "emoji", emoji: "✨" } });
            }}
          />
        </Field>
        <Show when={iconKind() === "emoji"}>
          <Field label={t().chooseEmoji}>
            {/* k2b-ui gap: no emoji picker in v2; the v1 picker stands in a v2 popover */}
            <Popover
              label={t().chooseEmoji}
              title={t().chooseEmoji}
              content={<EmojiPicker label={t().chooseEmoji} onPick={(emoji) => update({ icon: { kind: "emoji", emoji } })} />}
            >
              {emojiOf(draft().icon)}
            </Popover>
          </Field>
        </Show>
        <Show when={iconKind() === "image"}>
          <Field label={t().iconUpload}>
            <ImageInput
              value={imageOf(draft().icon)}
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              disabled={saving()}
              transform={async (file) => {
                try {
                  return await readImage(file);
                } catch (failure) {
                  setError(t().iconUploadFailed);
                  throw failure;
                }
              }}
              onChange={(dataUrl) => update({ icon: dataUrl ? { kind: "image", dataUrl } : { kind: "provider" } })}
            />
          </Field>
        </Show>
        <Field
          label={t().description}
          hint={`${t().descHelp} ${draft().description.length}/160`}
          error={!audio() && !draft().description.trim() ? t().noSubtitle : undefined}
        >
          <Input
            multiline
            maxLength={160}
            value={draft().description}
            disabled={saving()}
            onInput={(description) => update({ description })}
          />
        </Field>
      </Section>

      <Section icon="coin" title={t().prices} summary={audio() ? t().audioNoPrice : t().pricesSub}>
        <Show when={!audio()}>
          <Field label={t().setPrices}>
            <Check
              switch
              label={draft().priced ? t().on : t().off}
              checked={draft().priced}
              disabled={saving()}
              onChange={(priced) => update({ priced })}
            />
          </Field>
          <Show when={draft().priced} fallback={<Notice tone="warn">{t().unpricedWarn}</Notice>}>
            <Field label={t().inPrice} hint={example()}>
              <Input
                type="number"
                min={0}
                value={numberText(draft().inputPerMillion)}
                disabled={saving()}
                end={<Text type="meta">{t().perMillion({ unit: unit() })}</Text>}
                onInput={(value) => update({ inputPerMillion: numberOf(value) })}
              />
            </Field>
            <Field label={t().outPrice}>
              <Input
                type="number"
                min={0}
                value={numberText(draft().outputPerMillion)}
                disabled={saving()}
                end={<Text type="meta">{t().perMillion({ unit: unit() })}</Text>}
                onInput={(value) => update({ outputPerMillion: numberOf(value) })}
              />
            </Field>
          </Show>
          <Show when={unpricedChat()}>
            <Notice tone="note">{t().automationPriceRequired}</Notice>
          </Show>
          <Show when={limitsMissing()}>
            <Notice tone="warn">{t().modelLimitsRequired}</Notice>
          </Show>
        </Show>
      </Section>

      <Show when={!audio()}>
        <Section
          icon="gauge"
          title={t().budget}
          actions={[{ label: t().openBudgets, href: aiAreaHref({ sec: "budgets" }), forward: true }]}
        >
          <Text>
            {t().budgetRules({ p: props.usage?.budgetRules.length ?? 0 })}{" "}
            {(props.usage?.budgetRules ?? []).map((rule) => rule.label).join(" · ")}
          </Text>
          <Show when={(props.usage?.peopleAtLimit ?? 0) > 0}>
            <Notice tone="warn" icon="gauge">
              {t().atLimit({ p: props.usage?.peopleAtLimit ?? 0 })}
            </Notice>
          </Show>
        </Section>
      </Show>

      <Section icon="lock-access" title={t().access} summary={t().accessSub}>
        <Show
          when={props.provider.dataBoundary !== "restricted"}
          fallback={
            <>
              <Notice tone="warn" icon="shield-off">
                {t().accessAppsOnly}
              </Notice>
              <Facts items={[{ label: t().modelId, value: base().id, mono: true, copy: base().id }]} />
            </>
          }
        >
          <Choice
            name="model-access"
            label={t().access}
            value={draft().restricted ? "restricted" : "all"}
            disabled={saving()}
            options={[
              { value: "all", label: t().accessAll },
              { value: "restricted", label: t().accessRestricted },
            ]}
            onChange={(value) => update({ restricted: value === "restricted" })}
          />
          <Show when={draft().restricted}>
            <For each={draft().grants}>
              {(grant, index) => (
                <Row
                  avatar={{ name: principalLabel(grant, locale()) }}
                  lines={[principalLabel(grant, locale())]}
                  end={
                    <Button
                      variant="ghost"
                      icon="x"
                      label={t().delete}
                      disabled={saving()}
                      onClick={() => update({ grants: draft().grants.filter((_, position) => position !== index()) })}
                    />
                  }
                />
              )}
            </For>
            {/* k2b-ui gap: no person and group picker in v2; the v1 picker stands in */}
            <Field label={t().addPrincipalLabel}>
              <PrincipalPicker
                existing={draft().grants.map((grant) => grant.principal)}
                placeholder={t().addPrincipal}
                allowServiceAccounts
                onSelect={(principal, display) =>
                  update({ grants: [...draft().grants, { principal, displayName: display.displayName, avatarHash: display.avatarHash }] })
                }
              />
            </Field>
          </Show>
        </Show>
      </Section>

      <Section icon="cpu" title={t().modelSec}>
        {/* slot for #4208/#4223 (DP): the fields of this section and its advanced part become Setting rows (name left, value at a fixed width) */}
        <Field label={t().providerModelId}>
          <Input
            value={draft().providerModel}
            spellcheck={false}
            autocapitalize="off"
            disabled={saving()}
            onInput={(providerModel) => update({ providerModel })}
          />
        </Field>
        <Field label={t().kind}>
          <Choice
            name="model-kind"
            value={draft().kind}
            disabled={saving()}
            options={kinds()}
            onChange={(value) => {
              const kind = kinds().find((option) => option.value === value)?.value;
              if (kind === "chat" || kind === "decision" || kind === "transcription" || kind === "live-transcription") update({ kind });
            }}
          />
        </Field>
        <Show when={!audio()}>
          <Field label={t().caps} hint={draft().kind === "decision" ? t().decisionHelp : t().capsHelp}>
            <Inline>
              <Show when={chat()}>
                <Check label={t().capTools} checked={draft().tools} disabled={saving()} onChange={(tools) => update({ tools })} />
              </Show>
              <Check label={t().capVision} checked={draft().vision} disabled={saving()} onChange={(vision) => update({ vision })} />
            </Inline>
          </Field>
          <Field label={t().ctx}>
            <Input
              type="number"
              min={1}
              value={numberText(draft().contextWindow)}
              placeholder={t().providerDefault}
              disabled={saving()}
              end={<Text type="meta">{t().tokens}</Text>}
              onInput={(value) => update({ contextWindow: numberOf(value) })}
            />
          </Field>
          <Show when={chat()}>
            <Field label={t().maxOut} hint={t().maxOutHelp}>
              <Input
                type="number"
                min={1}
                value={numberText(draft().maxOutputTokens)}
                placeholder={t().providerDefault}
                disabled={saving()}
                end={<Text type="meta">{t().tokens}</Text>}
                onInput={(value) => update({ maxOutputTokens: numberOf(value) })}
              />
            </Field>
          </Show>
        </Show>
        <Facts items={[{ label: t().modelId, value: base().id, mono: true, copy: base().id, hint: t().modelIdHelp }]} />
      </Section>

      <Show when={chat()}>
        <Disclosure title={t().advanced}>
          <Field label={t().temperature} hint={t().temperatureHelp}>
            <Input
              type="number"
              min={0}
              max={2}
              value={numberText(draft().temperature)}
              placeholder={t().providerDefault}
              disabled={saving()}
              onInput={(value) => update({ temperature: numberOf(value) })}
            />
          </Field>
          <Field label={t().toolLoaded}>
            <Input
              type="number"
              min={0}
              value={numberText(draft().maxLoadedTools)}
              placeholder={t().unlimited}
              disabled={saving()}
              onInput={(value) => update({ maxLoadedTools: numberOf(value) })}
            />
          </Field>
          <Field label={t().toolRounds}>
            <Input
              type="number"
              min={0}
              value={numberText(draft().maxToolRounds)}
              placeholder={t().unlimited}
              disabled={saving()}
              onInput={(value) => update({ maxToolRounds: numberOf(value) })}
            />
          </Field>
          <Field label={t().extraParams} hint={t().extraParamsHelp} error={jsonError() || undefined}>
            <Input
              multiline
              value={draft().extraBody}
              spellcheck={false}
              placeholder='{ "top_p": 0.9 }'
              disabled={saving()}
              onInput={(extraBody) => update({ extraBody })}
            />
          </Field>
        </Disclosure>
      </Show>
    </Pane>
  );
}

import { type AiModel, type AiModelSlot, type AiModelVariant, type AiProvider, AiVariantSchema } from "@k2b/cloud/shared";
import { Button, Check, Dialog, Disclosure, Facts, Field, Input, Notice, Select, Text, useLocale, useToast } from "@k2b/ui/v2";
import { createResource, createSignal, Show } from "solid-js";
import { type AiAdminConflict, aiAdminApi, aiSlug, asAiConflict, readAiAdmin, reloadAiArea } from "./client";
import { ConflictNotice } from "./conflict";
import { aiAreaMessages } from "./messages";
import { type AiAreaMessages, aiProviderTypeInfo, aiSlotLabel } from "./presentation";

const EFFORTS = ["", "none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const CUSTOM = "__custom";

export const effortLabel = (t: AiAreaMessages, effort: string | null): string =>
  (
    ({
      "": t.eff_default,
      none: t.eff_none,
      minimal: t.eff_minimal,
      low: t.eff_low,
      medium: t.eff_medium,
      high: t.eff_high,
      xhigh: t.eff_xhigh,
      max: t.eff_max,
    }) as Record<string, string>
  )[effort ?? ""] ?? (effort as string);

type Draft = {
  label: string;
  reasoningEffort: string;
  hint: string;
  ownPrice: boolean;
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  ownOut: boolean;
  maxOutputTokens: number | null;
  showInPicker: boolean;
  extraBody: string;
};

const toDraft = (variant?: AiModelVariant): Draft => ({
  label: variant?.label ?? "",
  reasoningEffort: variant?.reasoningEffort ?? "",
  hint: variant?.hint ?? "",
  ownPrice: Boolean(variant?.pricing),
  inputPerMillion: variant?.pricing?.inputPerMillion ?? null,
  outputPerMillion: variant?.pricing?.outputPerMillion ?? null,
  ownOut: Boolean(variant?.maxOutputTokens),
  maxOutputTokens: variant?.maxOutputTokens ?? null,
  showInPicker: variant?.showInPicker ?? true,
  extraBody: variant?.extraBody ? JSON.stringify(variant.extraBody, null, 2) : "",
});

const numberText = (value: number | null) => (value === null ? "" : String(value));
const numberOf = (value: string) => (value.trim() === "" ? null : Number(value));

/**
 * B3: a variant inherits everything from its model except the thinking level and what it overrides. The dialog is
 * the screen's; `onDelete` hands a stored variant over to the delete dialog.
 */
export function VariantDialog(props: {
  open: boolean;
  onClose: () => void;
  model: AiModel & { variants: AiModelVariant[] };
  provider: AiProvider;
  variant?: AiModelVariant;
  onDelete: (variant: AiModelVariant) => void;
}) {
  const locale = useLocale();
  const t = () => aiAreaMessages.resolve([locale()]).t;
  const toast = useToast();
  const [base, setBase] = createSignal(props.variant);
  const [draft, setDraft] = createSignal(toDraft(props.variant));
  const [custom, setCustom] = createSignal(
    Boolean(props.variant?.reasoningEffort && !EFFORTS.some((effort) => effort === props.variant?.reasoningEffort)),
  );
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const [conflict, setConflict] = createSignal<AiAdminConflict<AiModelVariant> | null>(null);
  const close = (open: boolean) => {
    if (!open && !saving()) props.onClose();
  };
  const [slots] = createResource(
    () => props.variant?.id,
    async (id) =>
      (await readAiAdmin<{ assignments: AiModelSlot[] }>(await aiAdminApi.variants[":id"].usage.$get({ param: { id } }), t().loadFailed))
        .assignments,
  );
  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const isStandard = () => props.variant?.id === props.model.id;
  const variantId = () => (props.variant ? props.variant.id : `${props.model.id}:${aiSlug(draft().label) || "…"}`);

  const body = (value: Draft) => {
    let extraBody: Record<string, unknown> | null = null;
    if (value.extraBody.trim()) {
      const parsed: unknown = JSON.parse(value.extraBody);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError("object");
      extraBody = parsed as Record<string, unknown>;
    }
    return {
      label: value.label.trim(),
      reasoningEffort: value.reasoningEffort.trim() || null,
      hint: value.hint.trim(),
      pricing:
        value.ownPrice && value.inputPerMillion !== null && value.outputPerMillion !== null
          ? { ...base()?.pricing, inputPerMillion: value.inputPerMillion, outputPerMillion: value.outputPerMillion }
          : null,
      maxOutputTokens: value.ownOut ? value.maxOutputTokens : null,
      showInPicker: value.showInPicker,
      extraBody,
    };
  };

  const save = async (value = draft(), revision = base()?.revision) => {
    let json: ReturnType<typeof body>;
    try {
      json = body(value);
    } catch {
      setError(t().extraParamsInvalid);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const current = base();
      if (current && revision !== undefined)
        await readAiAdmin(
          await aiAdminApi.variants[":id"].$patch({ param: { id: current.id }, json: { revision, ...json } }),
          t().saveFailed,
        );
      else
        await readAiAdmin(
          await aiAdminApi.models[":id"].variants.$post({
            param: { id: props.model.id },
            json: { ...json, slug: aiSlug(value.label), position: props.model.variants.length },
          }),
          t().saveFailed,
        );
      toast(t().saved, { status: "ok" });
      reloadAiArea();
    } catch (failure) {
      const found = asAiConflict(failure, AiVariantSchema);
      if (found) setConflict(found);
      else setError(failure instanceof Error ? failure.message : t().saveFailed);
      setSaving(false);
    }
  };

  const effortValue = () =>
    custom() ? CUSTOM : EFFORTS.some((effort) => effort === draft().reasoningEffort) ? draft().reasoningEffort : CUSTOM;
  const modelPrice = () =>
    props.model.pricing ? `${props.model.pricing.inputPerMillion} / ${props.model.pricing.outputPerMillion}` : t().noPrices;

  return (
    <Dialog
      title={props.variant ? t().editVariant : t().newVariant}
      open={props.open}
      onOpenChange={close}
      dismissible={!saving()}
      foot={
        <>
          <Show when={props.variant && !isStandard()}>
            {/* k2b-ui gap: a destructive deed in a dialog's foot is no red text button yet; the delete dialog asks first */}
            <Button
              variant="text"
              icon="trash"
              disabled={saving()}
              onClick={() => {
                const variant = props.variant;
                if (variant && !saving()) props.onDelete(variant);
              }}
            >
              {t().deleteVariant}
            </Button>
          </Show>
          <Button disabled={saving()} onClick={() => close(false)}>
            {t().cancel}
          </Button>
          <Button variant="primary" icon="check" busy={saving()} disabled={!draft().label.trim()} onClick={() => void save()}>
            {t().save}
          </Button>
        </>
      }
    >
      <Text muted>{props.model.label}</Text>
      <Show when={conflict()}>
        {(current) => (
          <ConflictNotice<Draft>
            conflict={current()}
            fields={[
              { key: "label", label: t().variantName },
              { key: "reasoningEffort", label: t().thinkingLevel, format: (value) => effortLabel(t(), String(value ?? "")) },
              { key: "hint", label: t().hint },
              { key: "ownPrice", label: t().ownPrices },
              { key: "ownOut", label: t().ownOut },
              { key: "inputPerMillion", label: t().inPrice },
              { key: "outputPerMillion", label: t().outPrice },
              { key: "maxOutputTokens", label: t().maxOut },
              { key: "showInPicker", label: t().showInPicker },
              { key: "extraBody", label: t().extraParams },
            ]}
            base={toDraft(base())}
            mine={draft()}
            theirs={toDraft(current().current)}
            busy={saving()}
            onMerge={(merged) => {
              const theirs = current().current;
              setConflict(null);
              setBase(theirs);
              setDraft(merged);
              void save(merged, theirs.revision);
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
      <Show when={(slots() ?? []).length > 0}>
        <Notice tone="note">{t().variantInUse({ p: (slots() ?? []).map((slot) => aiSlotLabel(t(), slot)).join(", ") })}</Notice>
      </Show>
      <Field label={t().variantName} required>
        <Input value={draft().label} placeholder={t().variantNamePh} disabled={saving()} onInput={(label) => update({ label })} />
      </Field>
      <Field label={t().thinkingLevel} hint={t().effField({ p: aiProviderTypeInfo(props.provider.type).effortField })}>
        <Select
          value={effortValue()}
          disabled={saving()}
          options={[
            ...EFFORTS.map((effort) => ({ value: effort, label: effortLabel(t(), effort) })),
            { value: CUSTOM, label: t().effCustom },
          ]}
          onChange={(value) => {
            if (value === CUSTOM) setCustom(true);
            else {
              setCustom(false);
              update({ reasoningEffort: value });
            }
          }}
        />
      </Field>
      <Show when={custom()}>
        <Field label={t().effCustom}>
          <Input
            value={draft().reasoningEffort}
            spellcheck={false}
            disabled={saving()}
            onInput={(reasoningEffort) => update({ reasoningEffort })}
          />
        </Field>
      </Show>
      <Field label={t().hint} optional={t().optional}>
        <Input value={draft().hint} placeholder={t().hintPh} disabled={saving()} onInput={(hint) => update({ hint })} />
      </Field>
      <Check switch label={t().ownPrices} checked={draft().ownPrice} disabled={saving()} onChange={(ownPrice) => update({ ownPrice })} />
      <Show
        when={draft().ownPrice}
        fallback={
          <Text type="meta" muted>
            {t().fromModel({ p: modelPrice() })}
          </Text>
        }
      >
        <Field.Row>
          <Field label={t().inPrice}>
            <Input
              type="number"
              min={0}
              value={numberText(draft().inputPerMillion)}
              disabled={saving()}
              onInput={(value) => update({ inputPerMillion: numberOf(value) })}
            />
          </Field>
          <Field label={t().outPrice}>
            <Input
              type="number"
              min={0}
              value={numberText(draft().outputPerMillion)}
              disabled={saving()}
              onInput={(value) => update({ outputPerMillion: numberOf(value) })}
            />
          </Field>
        </Field.Row>
      </Show>
      <Check switch label={t().ownOut} checked={draft().ownOut} disabled={saving()} onChange={(ownOut) => update({ ownOut })} />
      <Show
        when={draft().ownOut}
        fallback={
          <Text type="meta" muted>
            {t().fromModel({
              p: props.model.maxOutputTokens
                ? `${props.model.maxOutputTokens.toLocaleString(locale())} ${t().tokens}`
                : t().providerDefault,
            })}
          </Text>
        }
      >
        <Field label={t().maxOut} hint={t().maxOutHelp} optional={t().tokens}>
          <Input
            type="number"
            min={1}
            value={numberText(draft().maxOutputTokens)}
            disabled={saving()}
            onInput={(value) => update({ maxOutputTokens: numberOf(value) })}
          />
        </Field>
      </Show>
      <Field label={t().showInPicker} hint={t().showInPickerHelp}>
        <Check
          switch
          label={draft().showInPicker ? t().on : t().off}
          checked={draft().showInPicker}
          disabled={saving()}
          onChange={(showInPicker) => update({ showInPicker })}
        />
      </Field>
      <Disclosure title={t().advanced}>
        <Field label={t().extraParams} hint={t().mergeHelp}>
          <Input
            multiline
            value={draft().extraBody}
            spellcheck={false}
            placeholder='{ "chat_template_kwargs": { "enable_thinking": false } }'
            disabled={saving()}
            onInput={(extraBody) => update({ extraBody })}
          />
        </Field>
        <Facts items={[{ label: t().variantId, value: variantId(), mono: true, copy: variantId(), hint: t().modelIdHelp }]} />
      </Disclosure>
      <Show when={error()}>
        <Notice tone="bad" title={t().saveFailed}>
          {error()}
        </Notice>
      </Show>
    </Dialog>
  );
}

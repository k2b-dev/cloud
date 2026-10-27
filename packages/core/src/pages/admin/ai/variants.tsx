import { type AiModel, type AiModelSlot, type AiModelVariant, type AiProvider, AiVariantSchema } from "@k2b/cloud/shared";
import {
  Button,
  Disclosure,
  dialogCore,
  NoticeCard,
  NumberInput,
  PanelDialog,
  panelDialogOptions,
  Select,
  Switch,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createResource, createSignal, Show } from "solid-js";
import { type AiAdminConflict, aiAdminApi, aiSlug, asAiConflict, readAiAdmin, reloadAiArea } from "./client";
import { ConflictNotice } from "./conflict";
import { openAiDelete } from "./delete";
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

/** B3: a variant inherits everything from its model except the thinking level and what it overrides. */
function VariantDialog(props: {
  model: AiModel & { variants: AiModelVariant[] };
  provider: AiProvider;
  variant?: AiModelVariant;
  close: () => void;
}) {
  const locale = useLocale();
  const t = () => aiAreaMessages.resolve([locale()]).t;
  const [base, setBase] = createSignal(props.variant);
  const [draft, setDraft] = createSignal(toDraft(props.variant));
  const [custom, setCustom] = createSignal(
    Boolean(props.variant?.reasoningEffort && !EFFORTS.some((e) => e === props.variant?.reasoningEffort)),
  );
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const [conflict, setConflict] = createSignal<AiAdminConflict<AiModelVariant> | null>(null);
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
          ? { inputPerMillion: value.inputPerMillion, outputPerMillion: value.outputPerMillion }
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
      toast.success(t().saved);
      props.close();
      reloadAiArea();
    } catch (failure) {
      const conflict = asAiConflict(failure, AiVariantSchema);
      if (conflict) setConflict(conflict);
      else setError(failure instanceof Error ? failure.message : t().saveFailed);
      setSaving(false);
    }
  };

  const effortValue = () =>
    custom() ? CUSTOM : EFFORTS.some((effort) => effort === draft().reasoningEffort) ? draft().reasoningEffort : CUSTOM;
  const modelPrice = () =>
    props.model.pricing ? `${props.model.pricing.inputPerMillion} / ${props.model.pricing.outputPerMillion}` : t().noPrices;

  return (
    <form
      class="contents"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft().label.trim() && !saving()) void save();
      }}
    >
      <PanelDialog>
        <PanelDialog.Header
          title={props.variant ? t().editVariant : t().newVariant}
          subtitle={props.model.label}
          icon="ti ti-versions"
          close={props.close}
          closeDisabled={saving()}
        />
        <PanelDialog.Body scrollPreserveKey="ai-variant">
          <Show when={conflict()}>
            {(current) => (
              <ConflictNotice<Draft>
                conflict={current()}
                fields={[
                  { key: "label", label: t().variantName },
                  { key: "reasoningEffort", label: t().thinkingLevel, format: (value) => effortLabel(t(), String(value ?? "")) },
                  { key: "hint", label: t().hint },
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
                  setConflict(null);
                  setBase(current().current);
                  setDraft(merged);
                  void save(merged, current().current.revision);
                }}
                onDiscard={() => {
                  setConflict(null);
                  setBase(current().current);
                  setDraft(toDraft(current().current));
                }}
              />
            )}
          </Show>
          <Show when={(slots() ?? []).length > 0}>
            <NoticeCard tone="info" title={t().variantInUse({ p: (slots() ?? []).map((slot) => aiSlotLabel(t(), slot)).join(", ") })} />
          </Show>
          <fieldset class="grid gap-4 sm:grid-cols-2" disabled={saving()}>
            <TextInput
              label={t().variantName}
              value={() => draft().label}
              onValueChange={(label) => update({ label })}
              placeholder={t().variantNamePh}
              required
            />
            <div class="grid gap-2">
              <Select
                label={t().thinkingLevel}
                value={effortValue}
                onValueChange={(value) => {
                  if (value === CUSTOM) setCustom(true);
                  else {
                    setCustom(false);
                    update({ reasoningEffort: value ?? "" });
                  }
                }}
                options={[
                  ...EFFORTS.map((effort) => ({ value: effort, label: effortLabel(t(), effort) })),
                  { value: CUSTOM, label: t().effCustom },
                ]}
                description={t().effField({ p: aiProviderTypeInfo(props.provider.type).effortField })}
              />
              <Show when={custom()}>
                <TextInput
                  aria-label={t().effCustom}
                  monospace
                  value={() => draft().reasoningEffort}
                  onValueChange={(reasoningEffort) => update({ reasoningEffort })}
                />
              </Show>
            </div>
            <TextInput
              class="sm:col-span-2"
              label={`${t().hint} · ${t().optional}`}
              value={() => draft().hint}
              onValueChange={(hint) => update({ hint })}
              placeholder={t().hintPh}
            />
            <div class="grid content-start gap-2">
              <Switch label={t().ownPrices} value={() => draft().ownPrice} onValueChange={(ownPrice) => update({ ownPrice })} />
              <Show when={draft().ownPrice} fallback={<p class="text-xs text-(--k2b-text-muted)">{t().fromModel({ p: modelPrice() })}</p>}>
                <div class="grid grid-cols-2 gap-2">
                  <NumberInput
                    aria-label={t().inPrice}
                    value={() => draft().inputPerMillion}
                    onValueChange={(inputPerMillion) => update({ inputPerMillion })}
                    min={0}
                    step={0.01}
                  />
                  <NumberInput
                    aria-label={t().outPrice}
                    value={() => draft().outputPerMillion}
                    onValueChange={(outputPerMillion) => update({ outputPerMillion })}
                    min={0}
                    step={0.01}
                  />
                </div>
              </Show>
            </div>
            <div class="grid content-start gap-2">
              <Switch label={t().ownOut} value={() => draft().ownOut} onValueChange={(ownOut) => update({ ownOut })} />
              <Show
                when={draft().ownOut}
                fallback={
                  <p class="text-xs text-(--k2b-text-muted)">
                    {t().fromModel({
                      p: props.model.maxOutputTokens
                        ? `${props.model.maxOutputTokens.toLocaleString(locale())} ${t().tokens}`
                        : t().providerDefault,
                    })}
                  </p>
                }
              >
                <NumberInput
                  aria-label={t().maxOut}
                  value={() => draft().maxOutputTokens}
                  onValueChange={(maxOutputTokens) => update({ maxOutputTokens })}
                  min={1}
                  suffix={t().tokens}
                />
              </Show>
            </div>
            <Switch
              class="sm:col-span-2"
              label={t().showInPicker}
              description={t().showInPickerHelp}
              value={() => draft().showInPicker}
              onValueChange={(showInPicker) => update({ showInPicker })}
            />
          </fieldset>
          <Disclosure summary={t().advanced} surface="plain">
            <div class="grid gap-4">
              <TextInput
                label={t().extraParams}
                multiline
                monospace
                lines={3}
                value={() => draft().extraBody}
                onValueChange={(extraBody) => update({ extraBody })}
                placeholder='{ "chat_template_kwargs": { "enable_thinking": false } }'
                description={t().mergeHelp}
              />
              <div class="grid gap-1">
                <span class="text-sm font-medium">{t().variantId}</span>
                <code class="text-sm">{variantId()}</code>
                <p class="text-xs text-(--k2b-text-muted)">{t().modelIdHelp}</p>
              </div>
            </div>
          </Disclosure>
          <Show when={error()}>
            <NoticeCard tone="danger" title={t().saveFailed} detail={error()} role="alert" />
          </Show>
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <Show when={props.variant && !isStandard()}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              class="me-auto text-(--k2b-danger-text)"
              disabled={saving()}
              onClick={() => {
                const variant = props.variant;
                if (!variant) return;
                props.close();
                openAiDelete({ kind: "variant", variant, model: props.model, provider: props.provider });
              }}
            >
              <i class="ti ti-trash" aria-hidden="true" />
              {t().deleteVariant}
            </Button>
          </Show>
          <Button type="button" variant="secondary" size="sm" onClick={props.close} disabled={saving()}>
            {t().cancel}
          </Button>
          <Button type="submit" size="sm" disabled={!draft().label.trim()} loading={saving()} loadingLabel={t().saving}>
            <i class="ti ti-check" aria-hidden="true" />
            {t().save}
          </Button>
        </PanelDialog.Footer>
      </PanelDialog>
    </form>
  );
}

export const openAiVariant = (input: { model: AiModel & { variants: AiModelVariant[] }; provider: AiProvider; variant?: AiModelVariant }) =>
  void dialogCore.open<void>((close) => <VariantDialog {...input} close={() => close()} />, panelDialogOptions);

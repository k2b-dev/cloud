import type { AiProvider, AiProviderType } from "@k2b/cloud/shared";
import {
  Bar,
  Button,
  Check,
  Choice,
  Dialog,
  Disclosure,
  Empty,
  Failed,
  Field,
  Inline,
  Input,
  Loading,
  Notice,
  Text,
  useLocale,
  useToast,
} from "@k2b/ui/v2";
import { createResource, createSignal, For, Show } from "solid-js";
import { CappedNote, capped } from "../_area/capped";
import { aiAreaHref } from "./area";
import { AiAdminError, aiAdminApi, aiSlug, readAiAdmin, reloadAiArea } from "./client";
import { aiAreaMessages } from "./messages";
import { proposeAiModelIds } from "./model-ids";
import { AI_PROVIDER_TYPES, type AiAreaMessages, aiProviderTypeDescription, aiProviderTypeInfo, aiProviderTypeLabel } from "./presentation";

type TestResult = { status: "ok" | "unreachable" | "key_rejected" | "error"; httpStatus?: number; message: string; latencyMs?: number };
type AvailableModel = {
  providerModel: string;
  label?: string;
  kind?: "chat" | "transcription" | "live-transcription" | "decision";
  contextWindow?: number;
  outputTokenLimit?: number;
};
type Boundary = AiProvider["dataBoundary"];

const useT = () => {
  const locale = useLocale();
  return () => aiAreaMessages.resolve([locale()]).t;
};

const testLine = (t: AiAreaMessages, result: TestResult | null, busy: boolean): { tone?: "ok" | "bad"; text: string } => {
  if (busy) return { text: t.testBusy };
  if (!result) return { text: t.testIdle };
  if (result.status === "ok") return { tone: "ok", text: `${t.stOk}${result.latencyMs ? ` · ${Math.round(result.latencyMs)} ms` : ""}` };
  if (result.status === "key_rejected") return { tone: "bad", text: t.testFailKey };
  if (result.status === "unreachable") return { tone: "bad", text: t.testFailNet };
  return { tone: "bad", text: result.message };
};

const boundaryHelp = (t: AiAreaMessages, boundary: Boundary) =>
  boundary === "private"
    ? t.boundaryHelpPrivate
    : boundary === "restricted"
      ? `${t.boundaryHelpRestricted} ${t.boundaryChosenOnce}`
      : t.boundaryHelpHosted;

const boundaryOptions = (t: AiAreaMessages, options: readonly Boundary[]) =>
  options.map((value) => ({ value, label: value === "hosted" ? t.hosted : value === "private" ? t.private : t.boundaryRestricted }));

/**
 * The data boundary as a choice; each option says what it means in its own words, so switching never changes the
 * dialog's height and nothing below or above it moves.
 */
export function BoundaryField(props: {
  t: AiAreaMessages;
  value: Boundary;
  options: readonly Boundary[];
  disabled?: boolean;
  onChange: (value: Boundary) => void;
}) {
  return (
    <Choice
      name="data-boundary"
      label={props.t.dataBoundary}
      value={props.value}
      disabled={props.disabled}
      options={boundaryOptions(props.t, props.options).map((option) => ({
        ...option,
        label: `${option.label} – ${boundaryHelp(props.t, option.value)}`,
      }))}
      onChange={(value) => props.onChange(props.options.find((option) => option === value) ?? props.value)}
    />
  );
}

/** Extra headers: names are visible, values are write-only. A stored header keeps its name and shows no value. */
export function HeaderRows(props: {
  t: AiAreaMessages;
  headers: { name: string; value: string; stored?: boolean }[];
  onChange: (headers: { name: string; value: string; stored?: boolean }[]) => void;
  disabled?: boolean;
}) {
  const update = (index: number, patch: Partial<{ name: string; value: string }>) =>
    props.onChange(props.headers.map((header, position) => (position === index ? { ...header, ...patch } : header)));
  return (
    <>
      <For each={props.headers}>
        {(header, index) => (
          <Field.Row>
            <Field label={props.t.headerName}>
              <Input
                value={header.name}
                placeholder={props.t.headerName}
                disabled={props.disabled || header.stored}
                spellcheck={false}
                autocapitalize="off"
                onInput={(value) => update(index(), { name: value })}
              />
            </Field>
            <Field
              label={props.t.headerValue}
              action={{
                label: props.t.delete,
                icon: "x",
                disabled: props.disabled,
                onClick: () => props.onChange(props.headers.filter((_, position) => position !== index())),
              }}
            >
              <Input
                type="password"
                autocomplete="off"
                value={header.value}
                placeholder={header.stored ? props.t.keyKeep : props.t.headerValue}
                disabled={props.disabled}
                onInput={(value) => update(index(), { value })}
              />
            </Field>
          </Field.Row>
        )}
      </For>
      <Bar
        start={<Text type="meta">{props.t.headersHelp}</Text>}
        end={
          <Button icon="plus" disabled={props.disabled} onClick={() => props.onChange([...props.headers, { name: "", value: "" }])}>
            {props.t.addHeader}
          </Button>
        }
      />
    </>
  );
}

/** B1: one dialog for a new provider: type, connection, a test, then the model list on the provider's page. */
export function AddProviderDialog(props: { open: boolean; onClose: () => void }) {
  const t = useT();
  let nameField: HTMLInputElement | HTMLTextAreaElement | undefined;
  const [created, setCreated] = createSignal<AiProvider | null>(null);
  const [type, setType] = createSignal<AiProviderType | null>(null);
  const [name, setName] = createSignal("");
  const [url, setUrl] = createSignal("");
  const [key, setKey] = createSignal("");
  const [boundary, setBoundary] = createSignal<Boundary>("hosted");
  const [headers, setHeaders] = createSignal<{ name: string; value: string }[]>([]);
  const [id, setId] = createSignal("");
  const [test, setTest] = createSignal<TestResult | null>(null);
  const [testing, setTesting] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const info = () => (type() ? aiProviderTypeInfo(type()!) : null);
  const providerId = () => id() || aiSlug(name() || (type() ? aiProviderTypeLabel(t(), type()!) : ""));
  const headerRecord = () =>
    Object.fromEntries(
      headers()
        .filter((header) => header.name.trim())
        .map((header) => [header.name.trim(), header.value]),
    );
  const canSave = () => Boolean(type() && name().trim() && providerId() && (info()?.url !== "required" || url().trim()) && !saving());
  // While a write runs nothing closes the dialog: Escape, the close button and a press outside wait for it.
  const close = (open: boolean) => {
    if (!open && !saving()) props.onClose();
  };

  const choose = (next: AiProviderType) => {
    setType(next);
    setBoundary(aiProviderTypeInfo(next).boundary);
    setTest(null);
    queueMicrotask(() => nameField?.focus());
  };

  const runTest = async () => {
    const current = type();
    if (!current) return;
    setTesting(true);
    setTest(null);
    try {
      const response = await aiAdminApi.providers.test.$post({
        json: {
          type: current,
          baseUrl: url().trim() || null,
          ...(key().trim() ? { apiKey: key().trim() } : {}),
          ...(info()?.headers && headers().length ? { headers: headerRecord() } : {}),
        },
      });
      setTest(await readAiAdmin<TestResult>(response, t().testFailNet));
    } catch (failure) {
      setTest({ status: "error", message: failure instanceof Error ? failure.message : t().testFailNet });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    const current = type();
    if (!current || !canSave()) return;
    setSaving(true);
    setError("");
    try {
      let provider =
        created() ??
        (await readAiAdmin<AiProvider>(
          await aiAdminApi.providers.$post({
            json: {
              id: providerId(),
              type: current,
              label: name().trim(),
              baseUrl: url().trim() || null,
              dataBoundary: boundary(),
              enabled: true,
              logo: null,
            },
          }),
          t().saveFailed,
        ));
      setCreated(provider);
      if (key().trim()) {
        provider = await readAiAdmin<AiProvider>(
          await aiAdminApi.providers[":id"].credential.$put({
            param: { id: provider.id },
            json: { revision: provider.revision, apiKey: key().trim() },
          }),
          t().saveFailed,
        );
        setCreated(provider);
        setKey("");
      }
      if (info()?.headers && headers().some((header) => header.name.trim())) {
        provider = await readAiAdmin<AiProvider>(
          await aiAdminApi.providers[":id"].headers.$put({
            param: { id: provider.id },
            json: { revision: provider.revision, headers: headerRecord() },
          }),
          t().saveFailed,
        );
        setCreated(provider);
        setHeaders([]);
      }
      reloadAiArea(aiAreaHref({ sec: "providers", p: provider.id }, { o: "models" }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t().saveFailed);
      setSaving(false);
    }
  };

  const line = () => testLine(t(), test(), testing());
  return (
    <Dialog
      title={t().provDlgNew}
      open={props.open}
      onOpenChange={close}
      dismissible={!saving()}
      foot={
        <>
          <Button disabled={saving()} onClick={() => close(false)}>
            {t().cancel}
          </Button>
          <Button variant="primary" icon="arrow-right" busy={saving()} disabled={!canSave()} onClick={() => void save()}>
            {t().saveAndPick}
          </Button>
        </>
      }
    >
      <Show
        when={type()}
        fallback={
          // k2b-ui gap: a choice of options with a sign and a sentence each (choice tiles); the type's sentence stands in its label
          <Choice
            name="provider-type"
            label={t().type}
            options={AI_PROVIDER_TYPES.map((entry) => ({
              value: entry.id,
              label: `${aiProviderTypeLabel(t(), entry.id)} – ${aiProviderTypeDescription(t(), entry.id)}`,
            }))}
            onChange={(value) => {
              const next = AI_PROVIDER_TYPES.find((entry) => entry.id === value);
              if (next) choose(next.id);
            }}
          />
        }
      >
        {(chosen) => (
          <Bar
            start={
              <Text>
                <Text weight="strong">{aiProviderTypeLabel(t(), chosen())}</Text> · {aiProviderTypeDescription(t(), chosen())}
              </Text>
            }
            end={
              <Button variant="text" disabled={saving() || Boolean(created())} onClick={() => setType(null)}>
                {t().change}
              </Button>
            }
          />
        )}
      </Show>
      <Show when={info()}>
        {(current) => (
          <>
            <Field label={t().name} required>
              <Input
                ref={(element) => {
                  nameField = element;
                }}
                value={name()}
                disabled={saving() || Boolean(created())}
                placeholder={current().id === "openai-compatible" ? t().namePh : aiProviderTypeLabel(t(), current().id)}
                onInput={setName}
              />
            </Field>
            <Field
              label={t().baseUrl}
              required={current().url === "required"}
              hint={current().url === "required" ? t().urlRequired : t().urlOptional}
              error={test()?.status === "unreachable" ? t().testFailNet : undefined}
            >
              <Input
                type="url"
                value={url()}
                spellcheck={false}
                autocapitalize="off"
                disabled={saving() || Boolean(created())}
                placeholder={
                  current().urlPlaceholder ?? (current().url === "required" ? "https://api.example.org/v1" : t().providerDefaultUrl)
                }
                onInput={(value) => {
                  setUrl(value);
                  setTest(null);
                }}
              />
            </Field>
            <Show when={current().key !== "none"}>
              <Field
                label={t().apiKey}
                optional={current().key === "optional" ? t().keyOptional : undefined}
                error={test()?.status === "key_rejected" ? t().keyRejected : undefined}
              >
                <Input
                  type="password"
                  autocomplete="off"
                  value={key()}
                  disabled={saving()}
                  placeholder={current().id === "openrouter" ? "sk-or-…" : "sk-…"}
                  onInput={(value) => {
                    setKey(value);
                    setTest(null);
                  }}
                />
              </Field>
            </Show>
            <Inline>
              <Button
                icon={test() && test()!.status !== "ok" ? "refresh" : "plug-connected"}
                busy={testing()}
                disabled={saving()}
                onClick={() => void runTest()}
              >
                {test() && test()!.status !== "ok" ? t().retry : t().testConn}
              </Button>
              <Text type="meta" tone={line().tone}>
                {line().text}
              </Text>
            </Inline>
            <BoundaryField
              t={t()}
              value={boundary()}
              options={["hosted", "private", "restricted"]}
              disabled={saving() || Boolean(created())}
              onChange={setBoundary}
            />
            <Disclosure title={t().advanced}>
              <Show when={current().headers}>
                <HeaderRows t={t()} headers={headers()} onChange={setHeaders} disabled={saving()} />
              </Show>
              <Field label={t().providerId} hint={t().modelIdHelp}>
                <Input
                  value={providerId()}
                  spellcheck={false}
                  autocapitalize="off"
                  disabled={saving() || Boolean(created())}
                  onInput={(value) => setId(aiSlug(value))}
                />
              </Field>
            </Disclosure>
          </>
        )}
      </Show>
      <Show when={error()}>
        <Notice tone="bad" title={created() ? t().providerCreatedRetry : t().saveFailed}>
          {error()}
        </Notice>
      </Show>
    </Dialog>
  );
}

/** B2: models from the provider's list, or a provider model ID by hand; the IDs Cloud gives them stay editable. */
export function AddModelsDialog(props: {
  open: boolean;
  onClose: () => void;
  providerId: string;
  providerType?: AiProviderType;
  chatOnly?: boolean;
  providerLabel: string;
  existing: string[];
}) {
  const t = useT();
  const toast = useToast();
  const [list, { refetch }] = createResource(
    () => (props.open ? props.providerId : false),
    async (id) => {
      const response = await aiAdminApi.providers[":id"]["available-models"].$get({ param: { id } });
      return (await readAiAdmin<{ models: AvailableModel[] }>(response, t().amFail)).models;
    },
  );
  const [modelIds, { refetch: refetchIds }] = createResource(
    () => props.open,
    async () =>
      (await readAiAdmin<{ models: { id: string }[] }>(await aiAdminApi.models.$get(), t().loadFailed)).models.map((model) => model.id),
  );
  const [ids, setIds] = createSignal<Record<string, string>>({});
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal<string[]>([]);
  const [manual, setManual] = createSignal(false);
  const [manualId, setManualId] = createSignal("");
  const [manualKind, setManualKind] = createSignal<"chat" | "decision">("chat");
  const [decisionContext, setDecisionContext] = createSignal<number | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const close = (open: boolean) => {
    if (!open && !saving()) props.onClose();
  };
  const visible = () => {
    const q = query().trim().toLowerCase();
    return (list() ?? []).filter(
      (model) =>
        (!props.chatOnly || (model.kind ?? "chat") === "chat") &&
        (!q || `${model.providerModel} ${model.label ?? ""}`.toLowerCase().includes(q)),
    );
  };
  const showManual = () => manual() || (list.state === "ready" && (list() ?? []).length === 0);
  const facts = (model: AvailableModel) =>
    model.kind === "live-transcription"
      ? t().kindLiveAudio
      : model.kind === "transcription"
        ? t().kindAudio
        : model.contextWindow
          ? `${Math.round(model.contextWindow / 1000)}k ${t().ctxShort}`
          : "";

  const picks = () => {
    const available = list() ?? [];
    return [
      ...new Map(
        [
          ...selected().map((providerModel) => available.find((model) => model.providerModel === providerModel) ?? { providerModel }),
          ...(showManual() && manualId().trim()
            ? [
                {
                  providerModel: manualId().trim(),
                  kind: manualKind(),
                  contextWindow: manualKind() === "decision" ? (decisionContext() ?? undefined) : undefined,
                },
              ]
            : []),
        ].map((model) => [model.providerModel, model]),
      ).values(),
    ];
  };
  const count = () => picks().length;
  const proposed = () =>
    proposeAiModelIds(
      props.providerId,
      picks().map((model) => model.providerModel),
      modelIds() ?? [],
      ids(),
    );
  const idsValid = () => {
    const values = Object.values(proposed());
    return values.every((id) => id && !(modelIds() ?? []).includes(id)) && new Set(values).size === values.length;
  };
  const add = async () => {
    if (picks().some((model) => model.kind === "decision" && !model.contextWindow)) {
      setError(t().decisionHelp);
      return;
    }
    if (saving() || !count() || modelIds.state !== "ready" || !idsValid()) return;
    setSaving(true);
    setError("");
    try {
      const body = picks().map((model) => ({
        id: proposed()[model.providerModel]!,
        providerModel: model.providerModel,
        label: model.label ?? model.providerModel.split("/").at(-1) ?? model.providerModel,
        kind: props.providerType === "vllm-realtime" ? ("live-transcription" as const) : (model.kind ?? ("chat" as const)),
        capabilities:
          props.providerType === "vllm-realtime" || model.kind === "live-transcription"
            ? ["live-transcription" as const]
            : model.kind === "transcription"
              ? ["transcription" as const]
              : [],
        contextWindow: model.contextWindow ?? null,
        ...(model.outputTokenLimit ? { outputTokenLimit: model.outputTokenLimit } : {}),
      }));
      const created = await readAiAdmin<{ models: { id: string }[] }>(
        await aiAdminApi.providers[":id"].models.$post({ param: { id: props.providerId }, json: body }),
        t().saveFailed,
      );
      toast(t().addedToast({ p: created.models.length }), { status: "ok" });
      reloadAiArea(aiAreaHref({ sec: "providers", p: props.providerId, m: created.models[0]?.id ?? "" }));
    } catch (failure) {
      setError(failure instanceof AiAdminError || failure instanceof Error ? failure.message : t().saveFailed);
      setSaving(false);
    }
  };
  const decision = () => props.providerType === "openai-compatible" && manualKind() === "decision";

  return (
    <Dialog
      title={t().amTitle({ p: props.providerLabel })}
      open={props.open}
      onOpenChange={close}
      dismissible={!saving()}
      foot={
        <>
          <Show when={!showManual()}>
            <Button variant="text" icon="pencil" disabled={saving()} onClick={() => setManual(true)}>
              {t().amManual}
            </Button>
          </Show>
          <Button disabled={saving()} onClick={() => close(false)}>
            {t().cancel}
          </Button>
          <Button
            variant="primary"
            icon="plus"
            busy={saving()}
            disabled={count() === 0 || modelIds.state !== "ready" || !idsValid()}
            onClick={() => void add()}
          >
            {t().amAddN({ p: count() })}
          </Button>
        </>
      }
    >
      <Show when={showManual()}>
        <Field label={t().amManual}>
          <Input
            value={manualId()}
            placeholder={t().amManualPh}
            spellcheck={false}
            autocapitalize="off"
            disabled={saving()}
            onInput={setManualId}
          />
        </Field>
        <Show when={props.providerType === "openai-compatible"}>
          <Choice
            name="manual-kind"
            label={t().kind}
            value={manualKind()}
            disabled={saving()}
            options={[
              { value: "chat", label: t().kindChat },
              { value: "decision", label: t().kindDecision },
            ]}
            onChange={(value) => setManualKind(value === "decision" ? "decision" : "chat")}
          />
          <Show when={decision()}>
            <Field label={t().ctx} hint={t().decisionHelp} required>
              <Input
                type="number"
                min={1}
                value={decisionContext() === null ? "" : String(decisionContext())}
                disabled={saving()}
                onInput={(value) => setDecisionContext(value === "" ? null : Number(value))}
              />
            </Field>
          </Show>
        </Show>
      </Show>
      <Show when={list.state === "pending" || list.state === "refreshing"}>
        <Loading rows={5} lines={2} />
      </Show>
      <Show when={list.state === "errored"}>
        <Notice
          tone="bad"
          title={t().amFail}
          actions={[{ label: t().amManual, icon: "pencil", onClick: () => setManual(true) }]}
          primary={{ label: t().retry, icon: "refresh", onClick: () => void refetch() }}
        >
          {t().listFailBanner}
        </Notice>
      </Show>
      <Show when={list.state === "ready" && (list() ?? []).length === 0}>
        <Empty icon="list-search" text={`${t().amEmpty}. ${t().amEmptySub}`} />
      </Show>
      <Show when={list.state === "ready" && (list() ?? []).length > 0}>
        <Input type="search" icon="search" label={t().amSearch} placeholder={t().amSearch} value={query()} onInput={setQuery} />
        {/* k2b-ui gap: a list of choices with a quiet second line (Check has one label); the facts follow the name */}
        {/* k2b-ui gap: virtual Table (MW, #4211); a provider offers hundreds of models, so the first matches show and the search reaches the rest */}
        <For each={capped(visible())}>
          {(model) => {
            const added = () => props.existing.includes(model.providerModel);
            return (
              <Check
                label={[
                  model.label ?? model.providerModel,
                  model.label ? model.providerModel : "",
                  facts(model),
                  added() ? t().amAdded : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
                checked={added() || selected().includes(model.providerModel)}
                disabled={added() || saving()}
                onChange={(checked) =>
                  setSelected((current) =>
                    checked ? [...current, model.providerModel] : current.filter((entry) => entry !== model.providerModel),
                  )
                }
              />
            );
          }}
        </For>
        <CappedNote total={visible().length} />
      </Show>
      <Show when={error()}>
        <Notice tone="bad" title={t().saveFailed}>
          {error()}
        </Notice>
      </Show>
      <Show when={count() > 0}>
        <Disclosure title={t().advanced}>
          <For each={picks()}>
            {(model) => (
              <Field
                label={`${t().modelId} · ${model.providerModel}`}
                hint={t().modelIdHelp}
                error={!idsValid() ? t().modelIdUnique : undefined}
              >
                <Input
                  value={proposed()[model.providerModel] ?? ""}
                  spellcheck={false}
                  autocapitalize="off"
                  disabled={saving()}
                  onInput={(value) => setIds((current) => ({ ...current, [model.providerModel]: aiSlug(value) }))}
                />
              </Field>
            )}
          </For>
        </Disclosure>
      </Show>
      <Show when={modelIds.error}>
        <Failed text={t().loadFailed} onRetry={() => void refetchIds()} />
      </Show>
    </Dialog>
  );
}

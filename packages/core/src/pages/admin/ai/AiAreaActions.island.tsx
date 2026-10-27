import { AiModelIcon } from "@k2b/cloud/ai/ui";
import { type AiProvider, type AiProviderType, aiProviderMark } from "@k2b/cloud/shared";
import {
  Button,
  Checkbox,
  Disclosure,
  dialogCore,
  IconButton,
  NoticeCard,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  SegmentedControl,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createResource, createSignal, For, onMount, Show } from "solid-js";
import { aiAreaHref } from "./area";
import { AiAdminError, aiAdminApi, aiSlug, readAiAdmin, reloadAiArea } from "./client";
import { aiAreaMessages } from "./messages";
import { AI_PROVIDER_TYPES, type AiAreaMessages, aiProviderTypeDescription, aiProviderTypeInfo, aiProviderTypeLabel } from "./presentation";

type TestResult = { status: "ok" | "unreachable" | "key_rejected" | "error"; httpStatus?: number; message: string; latencyMs?: number };
type AvailableModel = { providerModel: string; label?: string; kind?: "chat" | "transcription"; contextWindow?: number };

const useT = () => {
  const locale = useLocale();
  return () => aiAreaMessages.resolve([locale()]).t;
};

const TypeMark = (props: { type: AiProviderType; t: AiAreaMessages }) => (
  <AiModelIcon icon={{ kind: "mark", ...aiProviderMark({ id: props.type, label: aiProviderTypeLabel(props.t, props.type) }) }} size="sm" />
);

const testLine = (t: AiAreaMessages, result: TestResult | null, busy: boolean) => {
  if (busy) return { tone: "running", text: t.testBusy };
  if (!result) return { tone: "idle", text: t.testIdle };
  if (result.status === "ok") return { tone: "ok", text: `${t.stOk}${result.latencyMs ? ` · ${Math.round(result.latencyMs)} ms` : ""}` };
  if (result.status === "key_rejected") return { tone: "error", text: t.testFailKey };
  if (result.status === "unreachable") return { tone: "error", text: t.testFailNet };
  return { tone: "error", text: result.message };
};

const TestStatus = (props: { t: AiAreaMessages; result: TestResult | null; busy: boolean }) => {
  const line = () => testLine(props.t, props.result, props.busy);
  return (
    <p
      class="min-h-5 text-sm"
      classList={{
        "text-(--k2b-text-muted)": line().tone === "idle" || line().tone === "running",
        "text-(--k2b-success-text)": line().tone === "ok",
        "text-(--k2b-danger-text)": line().tone === "error",
      }}
      role="status"
    >
      {line().text}
    </p>
  );
};

/** B1: one dialog for a new provider: type, connection, a test, then the model list. */
function AddProviderDialog(props: { close: () => void }) {
  const t = useT();
  const [type, setType] = createSignal<AiProviderType | null>(null);
  const [name, setName] = createSignal("");
  const [url, setUrl] = createSignal("");
  const [key, setKey] = createSignal("");
  const [boundary, setBoundary] = createSignal<"hosted" | "private">("hosted");
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

  const choose = (next: AiProviderType) => {
    setType(next);
    setBoundary(aiProviderTypeInfo(next).boundary);
    setTest(null);
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
      let provider = await readAiAdmin<AiProvider>(
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
      );
      if (key().trim())
        provider = await readAiAdmin<AiProvider>(
          await aiAdminApi.providers[":id"].credential.$put({
            param: { id: provider.id },
            json: { revision: provider.revision, apiKey: key().trim() },
          }),
          t().saveFailed,
        );
      if (info()?.headers && headers().some((header) => header.name.trim()))
        await readAiAdmin<AiProvider>(
          await aiAdminApi.providers[":id"].headers.$put({
            param: { id: provider.id },
            json: { revision: provider.revision, headers: headerRecord() },
          }),
          t().saveFailed,
        );
      props.close();
      reloadAiArea(aiAreaHref({ sec: "providers", p: provider.id }, { o: "models" }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t().saveFailed);
      setSaving(false);
    }
  };

  return (
    <form
      class="contents"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <PanelDialog>
        <PanelDialog.Header
          title={t().provDlgNew}
          subtitle={t().provDlgSub}
          icon="ti ti-plug"
          close={props.close}
          closeDisabled={saving()}
        />
        <PanelDialog.Body scrollPreserveKey="ai-add-provider">
          <PanelDialog.Section title={t().type}>
            <Show
              when={type()}
              fallback={
                <div class="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t().type}>
                  <For each={AI_PROVIDER_TYPES}>
                    {(entry) => (
                      <button
                        type="button"
                        role="radio"
                        aria-checked="false"
                        class="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-(--k2b-surface-muted) focus-visible:outline-2 focus-visible:outline-(--k2b-focus-ring)"
                        onClick={() => choose(entry.id)}
                      >
                        <TypeMark type={entry.id} t={t()} />
                        <span class="grid gap-0.5">
                          <span class="text-sm font-medium">{aiProviderTypeLabel(t(), entry.id)}</span>
                          <span class="text-xs text-(--k2b-text-muted)">{aiProviderTypeDescription(t(), entry.id)}</span>
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              }
            >
              {(chosen) => (
                <div class="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-3 rounded-lg bg-(--k2b-surface-muted) px-3 py-2.5">
                  <TypeMark type={chosen()} t={t()} />
                  <span class="grid gap-0.5">
                    <span class="text-sm font-medium">{aiProviderTypeLabel(t(), chosen())}</span>
                    <span class="text-xs text-(--k2b-text-muted)">{aiProviderTypeDescription(t(), chosen())}</span>
                  </span>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setType(null)} disabled={saving()}>
                    {t().change}
                  </Button>
                </div>
              )}
            </Show>
          </PanelDialog.Section>
          <Show when={info()}>
            {(current) => (
              <PanelDialog.Section title={t().connection}>
                <fieldset class="grid gap-4" disabled={saving()}>
                  <TextInput
                    label={t().name}
                    value={name}
                    onValueChange={setName}
                    placeholder={current().id === "openai-compatible" ? t().namePh : aiProviderTypeLabel(t(), current().id)}
                    required
                  />
                  <TextInput
                    label={t().baseUrl}
                    type="url"
                    monospace
                    value={url}
                    onValueChange={(value) => {
                      setUrl(value);
                      setTest(null);
                    }}
                    placeholder={
                      current().urlPlaceholder ?? (current().url === "required" ? "https://api.example.com/v1" : t().providerDefaultUrl)
                    }
                    description={current().url === "required" ? t().urlRequired : t().urlOptional}
                    required={current().url === "required"}
                    error={() => (test()?.status === "unreachable" ? t().testFailNet : undefined)}
                  />
                  <Show when={current().key !== "none"}>
                    <TextInput
                      label={current().key === "optional" ? `${t().apiKey} · ${t().keyOptional}` : t().apiKey}
                      password
                      autocomplete="off"
                      value={key}
                      onValueChange={(value) => {
                        setKey(value);
                        setTest(null);
                      }}
                      placeholder={current().id === "openrouter" ? "sk-or-…" : "sk-…"}
                      error={() => (test()?.status === "key_rejected" ? t().keyRejected : undefined)}
                    />
                  </Show>
                  <div class="grid gap-1.5">
                    <SegmentedControl
                      label={t().dataBoundary}
                      value={boundary}
                      onValueChange={setBoundary}
                      options={[
                        { value: "hosted", label: t().hosted, icon: "ti ti-world" },
                        { value: "private", label: t().private, icon: "ti ti-lock" },
                      ]}
                    />
                    <p class="text-xs text-(--k2b-text-muted)">
                      {boundary() === "private" ? t().boundaryHelpPrivate : t().boundaryHelpHosted}
                    </p>
                  </div>
                </fieldset>
                <div class="mt-4 flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void runTest()}
                    loading={testing()}
                    disabled={saving()}
                  >
                    <i class={test() && test()!.status !== "ok" ? "ti ti-refresh" : "ti ti-plug-connected"} aria-hidden="true" />
                    {test() && test()!.status !== "ok" ? t().retry : t().testConn}
                  </Button>
                  <TestStatus t={t()} result={test()} busy={testing()} />
                </div>
                <Disclosure summary={t().advanced} surface="plain" class="mt-4">
                  <div class="grid gap-4">
                    <Show when={current().headers}>
                      <HeaderRows t={t()} headers={headers()} onChange={setHeaders} disabled={saving()} />
                    </Show>
                    <TextInput
                      label={t().providerId}
                      monospace
                      value={providerId}
                      onValueChange={(value) => setId(aiSlug(value))}
                      description={t().modelIdHelp}
                    />
                  </div>
                </Disclosure>
              </PanelDialog.Section>
            )}
          </Show>
          <Show when={error()}>
            <NoticeCard tone="danger" title={t().saveFailed} detail={error()} />
          </Show>
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <Button type="button" variant="secondary" size="sm" onClick={props.close} disabled={saving()}>
            {t().cancel}
          </Button>
          <Button type="submit" variant="ai" size="sm" disabled={!canSave()} loading={saving()} loadingLabel={t().saving}>
            {t().saveAndPick}
            <i class="ti ti-arrow-right" aria-hidden="true" />
          </Button>
        </PanelDialog.Footer>
      </PanelDialog>
    </form>
  );
}

/** Extra headers: names are visible, values are write-only. */
export function HeaderRows(props: {
  t: AiAreaMessages;
  headers: { name: string; value: string; stored?: boolean }[];
  onChange: (headers: { name: string; value: string; stored?: boolean }[]) => void;
  disabled?: boolean;
}) {
  const update = (index: number, patch: Partial<{ name: string; value: string }>) =>
    props.onChange(props.headers.map((header, position) => (position === index ? { ...header, ...patch } : header)));
  return (
    <div class="grid gap-2">
      <span class="text-sm font-medium">{props.t.extraHeaders}</span>
      <For each={props.headers}>
        {(header, index) => (
          <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
            <TextInput
              aria-label={props.t.headerName}
              monospace
              value={header.name}
              readOnly={header.stored}
              onValueChange={(value) => update(index(), { name: value })}
              placeholder={props.t.headerName}
              disabled={props.disabled}
            />
            <TextInput
              aria-label={props.t.headerValue}
              password
              value={header.value}
              onValueChange={(value) => update(index(), { value })}
              placeholder={header.stored ? props.t.keyKeep : props.t.headerValue}
              disabled={props.disabled}
            />
            <IconButton
              type="button"
              variant="ghost"
              size="sm"
              label={props.t.delete}
              disabled={props.disabled}
              onClick={() => props.onChange(props.headers.filter((_, position) => position !== index()))}
            >
              <i class="ti ti-x" aria-hidden="true" />
            </IconButton>
          </div>
        )}
      </For>
      <div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={props.disabled}
          onClick={() => props.onChange([...props.headers, { name: "", value: "" }])}
        >
          <i class="ti ti-plus" aria-hidden="true" />
          {props.t.addHeader}
        </Button>
      </div>
      <p class="text-xs text-(--k2b-text-muted)">{props.t.headersHelp}</p>
    </div>
  );
}

/** B2: models from the provider's list, or a provider model id by hand. */
function AddModelsDialog(props: { providerId: string; providerLabel: string; existing: string[]; close: () => void }) {
  const t = useT();
  const [list, { refetch }] = createResource(async () => {
    const response = await aiAdminApi.providers[":id"]["available-models"].$get({ param: { id: props.providerId } });
    return (await readAiAdmin<{ models: AvailableModel[] }>(response, t().amFail)).models;
  });
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal<string[]>([]);
  const [manual, setManual] = createSignal(false);
  const [manualId, setManualId] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const visible = () => {
    const q = query().trim().toLowerCase();
    return (list() ?? []).filter((model) => !q || `${model.providerModel} ${model.label ?? ""}`.toLowerCase().includes(q));
  };
  const count = () => selected().length + (manual() && manualId().trim() ? 1 : 0);
  const showManual = () => manual() || (list.state === "ready" && (list() ?? []).length === 0);
  const facts = (model: AvailableModel) =>
    model.kind === "transcription"
      ? t().kindAudio
      : model.contextWindow
        ? `${Math.round(model.contextWindow / 1000)}k ${t().ctxShort}`
        : "";

  const add = async () => {
    const available = list() ?? [];
    const picks = [
      ...selected().map((providerModel) => available.find((model) => model.providerModel === providerModel) ?? { providerModel }),
      ...(manual() && manualId().trim() ? [{ providerModel: manualId().trim() }] : []),
    ];
    if (picks.length === 0) return;
    setSaving(true);
    setError("");
    try {
      const body = picks.map((model) => ({
        id: aiSlug(model.providerModel.split("/").at(-1) ?? model.providerModel),
        providerModel: model.providerModel,
        label: model.label ?? model.providerModel.split("/").at(-1) ?? model.providerModel,
        kind: model.kind === "transcription" ? ("transcription" as const) : ("chat" as const),
        capabilities: model.kind === "transcription" ? (["transcription"] as const).slice() : [],
        contextWindow: model.contextWindow ?? null,
      }));
      const created = await readAiAdmin<{ models: { id: string }[] }>(
        await aiAdminApi.providers[":id"].models.$post({ param: { id: props.providerId }, json: body }),
        t().saveFailed,
      );
      toast.success(t().addedToast({ p: created.models.length }));
      props.close();
      reloadAiArea(aiAreaHref({ sec: "providers", p: props.providerId, m: created.models[0]?.id ?? "" }));
    } catch (failure) {
      setError(failure instanceof AiAdminError || failure instanceof Error ? failure.message : t().saveFailed);
      setSaving(false);
    }
  };

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={t().amTitle({ p: props.providerLabel })}
        subtitle={list.state === "ready" ? t().amSub({ p: (list() ?? []).length }) : undefined}
        icon="ti ti-list-search"
        close={props.close}
        closeDisabled={saving()}
      />
      <PanelDialog.Body scrollPreserveKey="ai-add-models">
        <Show when={showManual()}>
          <TextInput
            label={t().amManual}
            monospace
            value={manualId}
            onValueChange={setManualId}
            placeholder={t().amManualPh}
            disabled={saving()}
          />
        </Show>
        <Show when={list.state === "pending" || list.state === "refreshing"}>
          <Placeholder state="loading" title={t().modelsLoading} />
        </Show>
        <Show when={list.state === "errored"}>
          <Placeholder
            state="error"
            icon="ti ti-list-search"
            title={t().amFail}
            description={t().listFailBanner}
            action={
              <div class="flex flex-wrap justify-center gap-2">
                <Button type="button" variant="secondary" size="sm" onClick={() => void refetch()}>
                  <i class="ti ti-refresh" aria-hidden="true" />
                  {t().retry}
                </Button>
                <Button type="button" variant="secondary" size="sm" onClick={() => setManual(true)}>
                  <i class="ti ti-pencil" aria-hidden="true" />
                  {t().amManual}
                </Button>
              </div>
            }
          />
        </Show>
        <Show when={list.state === "ready" && (list() ?? []).length === 0}>
          <Placeholder icon="ti ti-list-search" title={t().amEmpty} description={t().amEmptySub} />
        </Show>
        <Show when={list.state === "ready" && (list() ?? []).length > 0}>
          <TextInput
            aria-label={t().amSearch}
            type="search"
            icon="ti ti-search"
            value={query}
            onValueChange={setQuery}
            placeholder={t().amSearch}
          />
          <ul class="grid">
            <For each={visible()}>
              {(model) => {
                const added = () => props.existing.includes(model.providerModel);
                return (
                  <li class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-(--k2b-border) py-2 last:border-b-0">
                    <Checkbox
                      label={model.label ?? model.providerModel}
                      description={[model.providerModel, facts(model)].filter(Boolean).join(" · ")}
                      value={() => added() || selected().includes(model.providerModel)}
                      disabled={added() || saving()}
                      onValueChange={(checked) =>
                        setSelected((current) =>
                          checked ? [...current, model.providerModel] : current.filter((entry) => entry !== model.providerModel),
                        )
                      }
                    />
                    <Show when={added()}>
                      <span class="inline-flex items-center gap-1 text-xs text-(--k2b-success-text)">
                        <i class="ti ti-check" aria-hidden="true" />
                        {t().amAdded}
                      </span>
                    </Show>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>
        <Show when={error()}>
          <NoticeCard tone="danger" title={t().saveFailed} detail={error()} />
        </Show>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Show when={!showManual()}>
          <Button type="button" variant="ghost" size="sm" class="me-auto" onClick={() => setManual(true)} disabled={saving()}>
            <i class="ti ti-pencil" aria-hidden="true" />
            {t().amManual}
          </Button>
        </Show>
        <Button type="button" variant="secondary" size="sm" onClick={props.close} disabled={saving()}>
          {t().cancel}
        </Button>
        <Button type="button" size="sm" onClick={() => void add()} disabled={count() === 0} loading={saving()} loadingLabel={t().saving}>
          <i class="ti ti-plus" aria-hidden="true" />
          {t().amAddN({ p: count() })}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export const openAddProvider = () => void dialogCore.open<void>((close) => <AddProviderDialog close={() => close()} />, panelDialogOptions);

export const openAddModels = (provider: { providerId: string; providerLabel: string; existing: string[] }) =>
  void dialogCore.open<void>((close) => <AddModelsDialog {...provider} close={() => close()} />, panelDialogOptions);

/** The area's entry points for B1 and B2; `?o=models` opens the model list right after a provider is saved. */
export default function AiAreaActions(props: {
  kind: "add-provider" | "add-models";
  variant?: "row" | "button" | "icon";
  providerId?: string;
  providerLabel?: string;
  existing?: string[];
}) {
  const t = useT();
  const open = () =>
    props.kind === "add-provider"
      ? openAddProvider()
      : openAddModels({ providerId: props.providerId ?? "", providerLabel: props.providerLabel ?? "", existing: props.existing ?? [] });
  onMount(() => {
    if (props.kind !== "add-models" || props.variant !== "button") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("o") !== "models") return;
    params.delete("o");
    window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params.toString()}`);
    open();
  });
  const label = () => (props.kind === "add-provider" ? t().addProvider : t().addModels);
  if (props.variant === "icon")
    return (
      <IconButton type="button" variant="ghost" size="sm" label={label()} onClick={open}>
        <i class="ti ti-plus" aria-hidden="true" />
      </IconButton>
    );
  if (props.variant === "row")
    return (
      <Button type="button" variant="text" size="sm" align="start" class="w-full" onClick={open}>
        <i class="ti ti-plus" aria-hidden="true" />
        {label()}
      </Button>
    );
  return (
    <Button type="button" variant={props.variant === "button" ? "secondary" : "primary"} size="sm" onClick={open}>
      <i class="ti ti-plus" aria-hidden="true" />
      {label()}
    </Button>
  );
}

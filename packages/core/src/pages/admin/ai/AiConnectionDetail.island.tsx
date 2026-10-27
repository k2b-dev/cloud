import { AiModelIcon } from "@k2b/cloud/ai/ui";
import { type AiModel, type AiProvider, AiProviderSchema, aiProviderMark } from "@k2b/cloud/shared";
import { Button, NoticeCard, SegmentedControl, StatusBadge, TextInput, toast, useLocale } from "@k2b/ui";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { HeaderRows } from "./AiAreaActions.island";
import AiProviderNotice from "./AiProviderNotice.island";
import { type AiAdminConflict, aiAdminApi, asAiConflict, readAiAdmin, reloadAiArea } from "./client";
import { ConflictNotice } from "./conflict";
import { openAiDelete } from "./delete";
import { setAiDetailControls } from "./detail-controls";
import { aiAreaMessages } from "./messages";
import {
  aiProviderState,
  aiProviderStateLabel,
  aiProviderStateTone,
  aiProviderTypeInfo,
  aiProviderTypeLabel,
  formatAiTime,
} from "./presentation";

type Draft = { label: string; baseUrl: string; dataBoundary: "hosted" | "private" };
type Header = { name: string; value: string; stored?: boolean };
const draftOf = (provider: AiProvider): Draft => ({
  label: provider.label,
  baseUrl: provider.baseUrl ?? "",
  dataBoundary: provider.dataBoundary,
});

/** A4: the provider's connection. Every model of the provider uses it. */
export default function AiConnectionDetail(props: { provider: AiProvider & { models: AiModel[] } }) {
  const locale = useLocale();
  const t = () => aiAreaMessages.resolve([locale()]).t;
  const [base, setBase] = createSignal<AiProvider>(props.provider);
  const [draft, setDraft] = createSignal(draftOf(props.provider));
  const [key, setKey] = createSignal("");
  const storedHeaders = () => base().requestHeaderNames.map((name) => ({ name, value: "", stored: true }));
  const [headers, setHeaders] = createSignal<Header[]>(storedHeaders());
  const [saving, setSaving] = createSignal(false);
  const [testing, setTesting] = createSignal(false);
  const [error, setError] = createSignal("");
  const [conflict, setConflict] = createSignal<AiAdminConflict<AiProvider> | null>(null);
  let keyField: HTMLDivElement | undefined;

  const info = () => aiProviderTypeInfo(base().type);
  const state = () => aiProviderState(base());
  const headerPatch = () => {
    const patch: Record<string, string | null> = {};
    for (const name of base().requestHeaderNames)
      if (!headers().some((header) => header.stored && header.name === name)) patch[name] = null;
    for (const header of headers()) if (header.name.trim() && header.value) patch[header.name.trim()] = header.value;
    return patch;
  };
  const fieldsDirty = () => JSON.stringify(draft()) !== JSON.stringify(draftOf(base()));
  const dirty = () => fieldsDirty() || Boolean(key().trim()) || Object.keys(headerPatch()).length > 0;

  const save = async (fields = draft(), revision = base().revision) => {
    setSaving(true);
    setError("");
    try {
      let provider: AiProvider = base();
      if (fields.label !== provider.label || fields.baseUrl !== (provider.baseUrl ?? "") || fields.dataBoundary !== provider.dataBoundary)
        provider = await readAiAdmin<AiProvider>(
          await aiAdminApi.providers[":id"].$patch({
            param: { id: provider.id },
            json: { revision, label: fields.label.trim(), baseUrl: fields.baseUrl.trim() || null, dataBoundary: fields.dataBoundary },
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
      if (Object.keys(headerPatch()).length)
        provider = await readAiAdmin<AiProvider>(
          await aiAdminApi.providers[":id"].headers.$put({
            param: { id: provider.id },
            json: { revision: provider.revision, headers: headerPatch() },
          }),
          t().saveFailed,
        );
      toast.success(t().saved);
      reloadAiArea();
    } catch (failure) {
      const conflict = asAiConflict(failure, AiProviderSchema);
      if (conflict) setConflict(conflict);
      else setError(failure instanceof Error ? failure.message : t().saveFailed);
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const result = await readAiAdmin<{ status: string; latencyMs?: number; message: string }>(
        await aiAdminApi.providers[":id"].test.$post({ param: { id: base().id } }),
        t().loadFailed,
      );
      if (result.status === "ok") toast.success(t().testOkPlain({ time: `${Math.round(result.latencyMs ?? 0)} ms` }));
      reloadAiArea();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t().loadFailed);
      setTesting(false);
    }
  };

  const toggle = async () => {
    setSaving(true);
    try {
      await readAiAdmin(
        await aiAdminApi.providers[":id"].$patch({
          param: { id: base().id },
          json: { revision: base().revision, enabled: !base().enabled },
        }),
        t().saveFailed,
      );
      reloadAiArea();
    } catch (failure) {
      const conflict = asAiConflict(failure, AiProviderSchema);
      if (conflict) setConflict(conflict);
      else setError(failure instanceof Error ? failure.message : t().saveFailed);
      setSaving(false);
    }
  };

  // The head island reads these controls; the effect keeps them current with the form.
  createEffect(() =>
    setAiDetailControls({
      test: { label: t().testConn, busy: testing(), disabled: !base().enabled || dirty(), run: () => void test() },
      save: { dirty: dirty() && !conflict(), saving: saving(), run: () => void save() },
    }),
  );
  onCleanup(() => setAiDetailControls(null));
  onMount(() => {
    if (new URLSearchParams(window.location.search).get("focus") === "key") keyField?.querySelector("input")?.focus();
  });

  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  return (
    <div class="grid gap-4 px-4 pb-8">
      <AiProviderNotice
        providerId={base().id}
        providerLabel={base().label}
        state={state()}
        statusMessage={base().statusMessage}
        checkedAt={base().statusCheckedAt}
        inConnection
      />
      <Show when={conflict()}>
        {(current) => (
          <ConflictNotice<Draft>
            conflict={current()}
            fields={[
              { key: "label", label: t().name },
              { key: "baseUrl", label: t().baseUrl },
              { key: "dataBoundary", label: t().dataBoundary, format: (value) => (value === "private" ? t().private : t().hosted) },
            ]}
            base={draftOf(base())}
            mine={draft()}
            theirs={draftOf(current().current)}
            busy={saving()}
            onMerge={(merged) => {
              const theirs = current().current;
              setConflict(null);
              setBase(theirs);
              setDraft(merged);
              void save(merged, theirs.revision);
            }}
            onDiscard={() => {
              setConflict(null);
              setBase(current().current);
              setDraft(draftOf(current().current));
              setKey("");
              setHeaders(current().current.requestHeaderNames.map((name) => ({ name, value: "", stored: true })));
            }}
          />
        )}
      </Show>
      <p class="flex items-center gap-1.5 text-sm text-(--k2b-text-secondary)">
        <StatusBadge tone={aiProviderStateTone(state())} variant="dot" label="" />
        {[
          aiProviderStateLabel(t(), state()),
          t().nModels({ p: props.provider.models.length }),
          base().statusCheckedAt ? t().checkedAt({ p: formatAiTime(locale(), base().statusCheckedAt) }) : "",
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <fieldset class="grid gap-5" disabled={saving()}>
        <div class="grid gap-1.5">
          <span class="text-sm font-medium">{t().type}</span>
          <span class="inline-flex items-center gap-2 text-sm">
            <AiModelIcon
              icon={{ kind: "mark", ...aiProviderMark({ id: base().type, label: aiProviderTypeLabel(t(), base().type) }) }}
              size="xs"
            />
            {aiProviderTypeLabel(t(), base().type)}
          </span>
          <p class="text-xs text-(--k2b-text-muted)">{t().typeFixed}</p>
        </div>
        <TextInput label={t().name} value={() => draft().label} onValueChange={(label) => update({ label })} required />
        <TextInput
          label={t().baseUrl}
          type="url"
          monospace
          value={() => draft().baseUrl}
          onValueChange={(baseUrl) => update({ baseUrl })}
          placeholder={info().urlPlaceholder ?? t().providerDefaultUrl}
          description={info().url === "required" ? t().urlRequired : t().urlOptional}
          required={info().url === "required"}
          error={() => (state() === "unreachable" && !fieldsDirty() ? t().testFailNet : undefined)}
        />
        <Show when={info().key !== "none"}>
          <div ref={keyField}>
            <TextInput
              label={t().apiKey}
              password
              autocomplete="off"
              value={key}
              onValueChange={setKey}
              placeholder={base().credentialSet ? t().keyKeep : "sk-…"}
              description={base().credentialSet ? t().keyStoredPlain : t().keyNone}
              error={() => (state() === "badkey" && !key() ? t().keyRejected : undefined)}
            />
          </div>
        </Show>
        <div class="grid gap-1.5">
          <SegmentedControl
            label={t().dataBoundary}
            value={() => draft().dataBoundary}
            onValueChange={(dataBoundary) => update({ dataBoundary })}
            disabled={saving()}
            options={[
              { value: "hosted", label: t().hosted, icon: "ti ti-world" },
              { value: "private", label: t().private, icon: "ti ti-lock" },
            ]}
          />
          <p class="text-xs text-(--k2b-text-muted)">
            {draft().dataBoundary === "private" ? t().boundaryHelpPrivate : t().boundaryHelpHosted}
          </p>
        </div>
        <Show when={info().headers}>
          <HeaderRows t={t()} headers={headers()} onChange={setHeaders} disabled={saving()} />
        </Show>
      </fieldset>
      <Show when={error()}>
        <NoticeCard tone="danger" title={t().saveFailed} detail={error()} role="alert" />
      </Show>
      <div class="mt-4 flex flex-wrap gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={saving()} onClick={() => void toggle()}>
          {base().enabled ? t().disable : t().enable}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          class="text-(--k2b-danger-text)"
          disabled={saving()}
          onClick={() => openAiDelete({ kind: "provider", provider: base() })}
        >
          <i class="ti ti-trash" aria-hidden="true" />
          {t().deleteProvider}
        </Button>
      </div>
    </div>
  );
}

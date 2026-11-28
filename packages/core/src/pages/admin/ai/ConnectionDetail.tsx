import type { AiProvider } from "@k2b/cloud/shared";
import { Bar, Button, Facts, Field, Input, Menu, Notice, Pane, Section, Text, useLocale, useToast } from "@k2b/ui/v2";
import { createSignal, onMount, Show } from "solid-js";
import { type AiAdminConflict, aiAdminApi, asAiConflict, readAiAdmin, reloadAiArea } from "./client";
import { ConflictNotice } from "./conflict";
import { aiAreaMessages } from "./messages";
import { aiProviderState, aiProviderTypeInfo, aiProviderTypeLabel } from "./presentation";
import { BoundaryField, HeaderRows } from "./provider-dialogs";
import { AiProviderNotice } from "./provider-notice";
import { AiProviderDetailSchema } from "./read-shapes";

type Draft = { label: string; baseUrl: string; dataBoundary: AiProvider["dataBoundary"] };
type Header = { name: string; value: string; stored?: boolean };
const draftOf = (provider: AiProvider): Draft => ({
  label: provider.label,
  baseUrl: provider.baseUrl ?? "",
  dataBoundary: provider.dataBoundary,
});

/**
 * A4: the provider's connection, which every model of the provider uses: name, address, key, data boundary and extra
 * headers, saved with "Speichern" in the head; testing, switching off and deleting wait behind "…".
 */
export default function ConnectionDetail(props: { provider: AiProvider; back: { label: string; href: string }; onDelete: () => void }) {
  const locale = useLocale();
  const t = () => aiAreaMessages.resolve([locale()]).t;
  const toast = useToast();
  const [base, setBase] = createSignal<AiProvider>(props.provider);
  const [draft, setDraft] = createSignal(draftOf(props.provider));
  const [key, setKey] = createSignal("");
  const storedHeaders = () => base().requestHeaderNames.map((name) => ({ name, value: "", stored: true }));
  const [headers, setHeaders] = createSignal<Header[]>(storedHeaders());
  const [saving, setSaving] = createSignal(false);
  const [testing, setTesting] = createSignal(false);
  const [error, setError] = createSignal("");
  const [conflict, setConflict] = createSignal<AiAdminConflict<AiProvider> | null>(null);
  let keyField: HTMLInputElement | HTMLTextAreaElement | undefined;

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
      toast(t().saved, { status: "ok" });
      reloadAiArea();
    } catch (failure) {
      const found = asAiConflict(failure, AiProviderDetailSchema);
      if (found) setConflict(found);
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
      if (result.status === "ok") toast(t().testOkPlain({ time: `${Math.round(result.latencyMs ?? 0)} ms` }), { status: "ok" });
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
      const found = asAiConflict(failure, AiProviderDetailSchema);
      if (found) setConflict(found);
      else setError(failure instanceof Error ? failure.message : t().saveFailed);
      setSaving(false);
    }
  };

  onMount(() => {
    if (new URLSearchParams(window.location.search).get("focus") === "key") keyField?.focus();
  });
  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  return (
    <Pane
      detail
      label={t().connection}
      back={props.back}
      scrollKey="admin-ai-connection"
      head={
        <Bar
          start={
            // slot for #4208/#4223 (DP): the tinted object head (ObjectHead, #4360) with the provider's mark (its kind's symbol in its colour); the name stands in
            <Text type="body">{t().connectionOf({ p: base().label })}</Text>
          }
          end={
            <>
              <Menu
                label={t().moreActions}
                items={[
                  {
                    label: t().testConn,
                    icon: "plug-connected",
                    disabled: !base().enabled || dirty() || saving() || testing(),
                    onClick: () => void test(),
                  },
                  { label: base().enabled ? t().disable : t().enable, icon: "power", disabled: saving(), onClick: () => void toggle() },
                  { label: t().deleteProvider, icon: "trash", danger: true, disabled: saving(), onClick: props.onDelete },
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
        providerId={base().id}
        providerLabel={base().label}
        state={state()}
        status={base().status}
        statusCode={base().statusCode}
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
              {
                key: "dataBoundary",
                label: t().dataBoundary,
                format: (value) => (value === "private" ? t().private : value === "restricted" ? t().boundaryRestricted : t().hosted),
              },
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
              const theirs = current().current;
              setConflict(null);
              setBase(theirs);
              setDraft(draftOf(theirs));
              setKey("");
              setHeaders(theirs.requestHeaderNames.map((name) => ({ name, value: "", stored: true })));
            }}
          />
        )}
      </Show>
      <Show when={error()}>
        <Notice tone="bad" title={t().saveFailed}>
          {error()}
        </Notice>
      </Show>
      <Section icon="plug-connected" title={t().connection}>
        <Facts items={[{ label: t().type, value: aiProviderTypeLabel(t(), base().type), hint: t().typeFixed }]} />
        <Field label={t().name} required>
          <Input value={draft().label} disabled={saving()} onInput={(label) => update({ label })} />
        </Field>
        <Field
          label={t().baseUrl}
          required={info().url === "required"}
          hint={info().url === "required" ? t().urlRequired : t().urlOptional}
          error={state() === "unreachable" && !fieldsDirty() ? t().testFailNet : undefined}
        >
          <Input
            type="url"
            value={draft().baseUrl}
            spellcheck={false}
            autocapitalize="off"
            placeholder={info().urlPlaceholder ?? t().providerDefaultUrl}
            disabled={saving()}
            onInput={(baseUrl) => update({ baseUrl })}
          />
        </Field>
        <Show when={info().key !== "none"}>
          <Field
            label={t().apiKey}
            hint={base().credentialSet ? t().keyStoredPlain : t().keyNone}
            error={state() === "badkey" && !key() ? t().keyRejected : undefined}
          >
            <Input
              ref={(element) => {
                keyField = element;
              }}
              type="password"
              autocomplete="off"
              value={key()}
              placeholder={base().credentialSet ? t().keyKeep : "sk-…"}
              disabled={saving()}
              onInput={setKey}
            />
          </Field>
        </Show>
      </Section>
      <Section icon="shield" title={t().dataBoundary}>
        <Show
          when={base().dataBoundary !== "restricted"}
          fallback={
            <Notice tone="warn" icon="shield-off" title={t().boundaryRestricted}>
              {`${t().boundaryHelpRestricted} ${t().boundaryFixed}`}
            </Notice>
          }
        >
          <BoundaryField
            t={t()}
            value={draft().dataBoundary}
            options={["hosted", "private"]}
            disabled={saving()}
            onChange={(dataBoundary) => update({ dataBoundary })}
          />
        </Show>
      </Section>
      <Show when={info().headers}>
        <Section icon="list-details" title={t().extraHeaders}>
          <HeaderRows t={t()} headers={headers()} onChange={setHeaders} disabled={saving()} />
        </Section>
      </Show>
    </Pane>
  );
}

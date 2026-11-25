import { coreClient } from "@k2b/cloud/clients/core";
import { type LinuxIdentityConfiguration, LinuxIdentityConfigurationSchema } from "@k2b/cloud/contracts";
import type { linuxIdentities, PosixCandidate } from "@k2b/cloud/services";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Check, Dialog, Field, FilterBar, Input, Notice, Section, StatusRow, Table, Text, useToast } from "@k2b/ui/v2";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { linuxErrorText, linuxMessages } from "../settings/_components/linux-messages";
import { type LinuxState, linuxHref, linuxQuery } from "./linux-query";

export type LinuxOverview = Awaited<ReturnType<typeof linuxIdentities.overview>>;

const editableConfig = ({ unreadable: _unreadable, ...value }: LinuxIdentityConfiguration & { unreadable?: boolean }) => value;
const api = coreClient.admin.core["linux-identities"];
const responseError = async (response: { json(): Promise<unknown> }): Promise<Error> => {
  const body: unknown = await response.json().catch(() => null);
  return new Error(body && typeof body === "object" && "code" in body && typeof body.code === "string" ? body.code : "error");
};

/**
 * Local Linux identities on v2: the setup (checked and saved as one, the ID range confirmed as reserved), and the
 * accounts with a filter bar, a selection and a backfill that runs one account after another and can stop after the
 * current one. The server reads the first page with the page; a filter or a page change loads in place.
 */
export function useLinuxIdentities(props: { initial: LinuxOverview; state: LinuxState; after: string | null }) {
  const locale = useLocale();
  const t = () => linuxMessages.resolve([locale()]).t;
  const toast = useToast();
  const query = createMemo(() => linuxQuery(locale()));
  const [state, setState] = createSignal(props.state);
  const [after, setAfter] = createSignal(props.after);
  const [overview, setOverview] = createSignal(props.initial);
  const [loading, setLoading] = createSignal(false);
  const [loadError, setLoadError] = createSignal<Error | null>(null);
  const [draft, setDraft] = createSignal(editableConfig(props.initial.config));
  const [replace, setReplace] = createSignal(false);
  const [editing, setEditing] = createSignal(props.initial.config.enabled);
  const [reserved, setReserved] = createSignal(false);
  const [selected, setSelected] = createSignal<readonly string[]>([]);
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<Error | null>(null);
  const [preparing, setPreparing] = createSignal(false);
  const [prepareError, setPrepareError] = createSignal<Error | null>(null);
  const [stopped, setStopped] = createSignal(false);
  const [progress, setProgress] = createSignal({ done: 0, total: 0 });
  let stopRequested = false;
  let disposed = false;
  let controller: AbortController | undefined;
  onCleanup(() => {
    disposed = true;
    stopRequested = true;
    controller?.abort();
  });

  const load = async () => {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    setLoading(true);
    try {
      const response = await api.$get(
        { query: { after: after() ?? undefined, search: state().search ?? "", scope: state().filters.scope ?? "ready" } },
        { init: { signal: current.signal } },
      );
      if (!response.ok) throw await responseError(response);
      setOverview(await response.json());
      setLoadError(null);
    } catch (error) {
      if (!current.signal.aborted) setLoadError(error instanceof Error ? error : new Error("error"));
    } finally {
      if (controller === current) setLoading(false);
    }
  };
  const config = () => overview().config;
  const dirty = () => replace() || JSON.stringify(draft()) !== JSON.stringify(editableConfig(config()));
  const valid = createMemo(() => LinuxIdentityConfigurationSchema.safeParse(draft()).success);
  const change = <K extends keyof LinuxIdentityConfiguration>(key: K, value: LinuxIdentityConfiguration[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setStopped(false);
    if (key === "rangeStart" || key === "rangeEnd") setReserved(false);
  };
  const discard = () => {
    setDraft(editableConfig(config()));
    setReplace(false);
    setEditing(config().enabled);
    setReserved(false);
  };
  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const response = await api.configuration.$put({
        json: { config: draft(), rangeReserved: reserved(), replaceUnreadable: config().unreadable === true && replace() },
      });
      if (!response.ok) {
        const error = await responseError(response);
        if (error.message === "setting_unreadable") await load();
        throw error;
      }
      const saved = await response.json();
      await load();
      setDraft(saved);
      setReplace(false);
      setEditing(saved.enabled);
      setReserved(false);
      setSelected([]);
      toast(t().saved, { status: "ok" });
    } catch (error) {
      setSaveError(error instanceof Error ? error : new Error("error"));
    } finally {
      setSaving(false);
    }
  };
  const prepare = async (ids: readonly string[]) => {
    stopRequested = false;
    setStopped(false);
    setPrepareError(null);
    setPreparing(true);
    setProgress({ done: 0, total: ids.length });
    try {
      for (const id of ids) {
        if (stopRequested) {
          setStopped(true);
          break;
        }
        const response = await api.users[":id"].$post({ param: { id } });
        if (!response.ok) throw await responseError(response);
        setProgress((current) => ({ ...current, done: current.done + 1 }));
        setSelected((current) => current.filter((value) => value !== id));
      }
      if (progress().total > 0 && progress().done === progress().total) {
        toast(t().preparedSuccess({ count: progress().done }), { status: "ok" });
        setProgress({ done: 0, total: 0 });
      }
    } catch (error) {
      setPrepareError(error instanceof Error ? error : new Error("error"));
    } finally {
      setPreparing(false);
      if (!disposed) await load();
    }
  };
  const busy = () => saving() || preparing() || loading();
  const begin = async () => {
    const ids = [...selected()];
    if (!ids.length || busy() || dirty()) return;
    if (
      (await Dialog.confirm({ title: t().confirmTitle, description: t().confirm, confirm: t().prepare({ count: ids.length }) })) &&
      !disposed
    )
      await prepare(ids);
  };
  /** A new filter or page loads in place; the bar or the link already wrote the address. */
  const show = (next: LinuxState, cursor: string | null = null) => {
    setState(next);
    setAfter(cursor);
    setSelected([]);
    if (cursor !== props.after || next !== props.state) history.replaceState(history.state, "", linuxHref(query(), next, cursor));
    void load();
  };
  const eligible = (row: PosixCandidate) => row.state === "ready";
  const errors = () => [saveError(), prepareError(), loadError()].filter((error): error is Error => error !== null);
  return {
    t,
    query,
    state,
    after,
    overview,
    loading,
    draft,
    replace,
    setReplace,
    editing,
    setEditing,
    reserved,
    setReserved,
    selected,
    setSelected,
    saving,
    progress,
    preparing,
    stopped,
    stop: () => {
      stopRequested = true;
    },
    config,
    dirty,
    valid,
    change,
    discard,
    save,
    begin,
    show,
    eligible,
    errors,
    busy,
    refresh: () => void load(),
  };
}

type Linux = ReturnType<typeof useLinuxIdentities>;

/** What stays under the head: the filter statements, then the count and, while selecting, what can be done. */
export function LinuxStatus(props: { linux: Linux }) {
  const linux = props.linux;
  const t = linux.t;
  const rows = () => linux.overview().items;
  return (
    <Show when={linux.config().enabled}>
      <FilterBar
        query={linux.query()}
        state={linux.state()}
        onChange={(next) => linux.show(next)}
        results={t().visibleAccounts({ count: rows().length })}
      />
      <StatusRow
        lead={t().visibleAccounts({ count: rows().length })}
        loading={linux.loading()}
        selection={
          linux.selected().length > 0
            ? {
                count: t().selectedCount({ count: linux.selected().length }),
                actions: [
                  {
                    label: t().prepare({ count: linux.selected().length }),
                    icon: "user-check",
                    onClick: () => void linux.begin(),
                    disabled: linux.busy() || linux.dirty(),
                  },
                ],
                clear: { label: t().clear, onClick: () => linux.setSelected([]) },
              }
            : undefined
        }
      />
    </Show>
  );
}

/** The setup and the accounts. */
export function LinuxContent(props: { linux: Linux }) {
  const linux = props.linux;
  const t = linux.t;
  const rows = () => linux.overview().items;
  const scope = () => linux.state().filters.scope ?? "ready";
  const statusText = (row: PosixCandidate) =>
    row.state === "ready" && linux.dirty()
      ? t().saveFirst
      : row.provider === "ipa" && row.state === "prepared"
        ? t().ipaManaged
        : t()[row.state];
  const home = (row: PosixCandidate) =>
    row.identity?.homeDirectory ??
    (row.state === "ready" && linux.config().enabled ? linux.config().homeTemplate.replaceAll("{username}", row.uid) : "—");
  const number = (value: string) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : 0;
  };
  return (
    <>
      <Notice tone="note" icon="info-circle" title={t().scope}>
        {t().scopeDescription}
      </Notice>
      <For each={linux.errors()}>{(error) => <Notice tone="bad">{linuxErrorText(error.message, t())}</Notice>}</For>
      <Show when={linux.progress().total > 0 || linux.stopped()}>
        <Notice
          tone="note"
          icon="progress"
          title={linux.stopped() ? t().stopped : t().progress(linux.progress())}
          actions={linux.preparing() ? [{ label: t().stop, icon: "player-stop", onClick: linux.stop }] : undefined}
        >
          {linux.stopped() ? t().progress(linux.progress()) : t().confirm}
        </Notice>
      </Show>
      <Section icon="terminal-2" title={t().setup} summary={t().enableDescription}>
        <Show when={linux.config().unreadable}>
          <Notice tone="warn" icon="eye-off" title={t().unreadableTitle}>
            {t().unreadableDetail}
          </Notice>
          <Check
            label={`${t().replaceStored}: ${t().setup}`}
            checked={linux.replace()}
            disabled={linux.busy()}
            onChange={(value) => {
              linux.setReplace(value);
              if (value) linux.setEditing(true);
            }}
          />
        </Show>
        <Show when={!linux.editing()}>
          <Bar
            end={
              <Button
                icon="settings"
                onClick={() => {
                  linux.setEditing(true);
                  linux.change("enabled", true);
                }}
              >
                {t().begin}
              </Button>
            }
          />
        </Show>
        <Show when={linux.editing()}>
          <Check
            switch
            label={t().enable}
            checked={linux.draft().enabled}
            disabled={linux.busy()}
            onChange={(value) => linux.change("enabled", value)}
          />
          <Show when={linux.draft().enabled}>
            <Text muted>{t().defaultsDescription}</Text>
            <Field name="homeTemplate" label={t().home} hint={t().homeHint}>
              <Input value={linux.draft().homeTemplate} disabled={linux.busy()} onInput={(value) => linux.change("homeTemplate", value)} />
            </Field>
            <Field name="loginShell" label={t().shell} hint={t().shellHint}>
              <Input value={linux.draft().loginShell} disabled={linux.busy()} onInput={(value) => linux.change("loginShell", value)} />
            </Field>
            <Text muted>{t().rangeHint}</Text>
            <Field.Row>
              <Field name="rangeStart" label={t().start}>
                <Input
                  type="number"
                  min={1000}
                  max={2147483647}
                  value={linux.draft().rangeStart ? String(linux.draft().rangeStart) : ""}
                  disabled={linux.busy()}
                  onInput={(value) => linux.change("rangeStart", number(value))}
                />
              </Field>
              <Field name="rangeEnd" label={t().end}>
                <Input
                  type="number"
                  min={1000}
                  max={2147483647}
                  value={linux.draft().rangeEnd ? String(linux.draft().rangeEnd) : ""}
                  disabled={linux.busy()}
                  onInput={(value) => linux.change("rangeEnd", number(value))}
                />
              </Field>
            </Field.Row>
            <Show when={linux.dirty()}>
              <Check label={t().reserved} checked={linux.reserved()} disabled={linux.busy()} onChange={linux.setReserved} />
              <Text type="meta" muted>
                {t().reservedHint}
              </Text>
            </Show>
            <Show when={!linux.valid()}>
              <Notice tone="bad">{t().invalid}</Notice>
            </Show>
          </Show>
          <Show when={linux.dirty()}>
            <Bar
              end={
                <>
                  <Button disabled={linux.busy()} onClick={linux.discard}>
                    {t().discard}
                  </Button>
                  <Button
                    variant="primary"
                    busy={linux.saving()}
                    disabled={
                      linux.busy() ||
                      (linux.config().unreadable === true && !linux.replace()) ||
                      !linux.valid() ||
                      (linux.draft().enabled && !linux.reserved())
                    }
                    onClick={() => void linux.save()}
                  >
                    {linux.draft().enabled ? t().save : t().saveDisabled}
                  </Button>
                </>
              }
            />
          </Show>
        </Show>
      </Section>
      <Show when={linux.config().enabled}>
        <Section icon="users" title={t().inventory} summary={t().inventoryHint}>
          <Table
            label={t().inventory}
            rows={rows()}
            rowKey={(row) => row.id}
            select={
              linux.dirty()
                ? undefined
                : {
                    selected: linux.selected(),
                    // only accounts with a missing identity can be backfilled
                    onChange: (keys) =>
                      linux.setSelected(keys.filter((key) => rows().some((row) => row.id === key && linux.eligible(row)))),
                    all: t().selectPage,
                    row: (row) => `${t().select}: ${row.uid}`,
                  }
            }
            loading={linux.loading() && rows().length === 0}
            empty={{
              icon: "users",
              text: scope() === "ready" ? t().emptyReady : t().empty,
              ...(scope() === "ready"
                ? {
                    action: {
                      label: t().allAccounts,
                      onClick: () => linux.show(linux.query().set(linux.state(), "scope", "all") ?? linux.state()),
                    },
                  }
                : {}),
            }}
            phone={(row) => ({ lines: [row.displayName || row.uid, statusText(row)] })}
            columns={[
              { title: t().name, width: { min: 180, default: 240 }, cell: (row) => ({ lines: [row.displayName || row.uid, row.uid] }) },
              {
                title: t().source,
                width: { min: 100, default: 120 },
                cell: (row) => ((row.identity?.managedBy ?? row.provider) === "ipa" ? "FreeIPA" : t().local),
              },
              { title: t().status, width: { min: 180, default: 240 }, cell: statusText },
              {
                title: t().identity,
                width: { min: 120, default: 140 },
                drop: true,
                cell: (row) => `${row.identity?.uidNumber ?? "—"} / ${row.identity?.primaryGidNumber ?? "—"}`,
              },
              { title: t().homePreview, drop: true, cell: home },
            ]}
          />
          <Show when={!linux.busy() && !linux.dirty() && (linux.after() || linux.overview().nextCursor)}>
            <Bar
              end={
                <>
                  <Show when={linux.after()}>
                    <Button icon="chevrons-left" href={linuxHref(linux.query(), linux.state())}>
                      {t().first}
                    </Button>
                  </Show>
                  <Show when={linux.overview().nextCursor}>
                    {(cursor) => (
                      <Button forward href={linuxHref(linux.query(), linux.state(), cursor())}>
                        {t().next}
                      </Button>
                    )}
                  </Show>
                </>
              }
            />
          </Show>
        </Section>
      </Show>
    </>
  );
}

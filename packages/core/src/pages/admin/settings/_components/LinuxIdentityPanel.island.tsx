import { mutation, query } from "@k2b/stdlib/solid";
import {
  Button,
  ButtonLink,
  CheckboxCard,
  DataPanel,
  DataTable,
  type DataTableColumn,
  Disclosure,
  NumberInput,
  SettingsPage,
  SettingsSection,
  TextInput,
  prompts,
  useLocale,
} from "@k2b/ui";
import { coreClient } from "@valentinkolb/cloud/clients/core";
import { LinuxIdentityConfigurationSchema, type LinuxIdentityConfiguration } from "@valentinkolb/cloud/contracts";
import type { linuxIdentities, PosixCandidate } from "@valentinkolb/cloud/services";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { linuxErrorText, linuxMessages } from "./linux-messages";

type Overview = Awaited<ReturnType<typeof linuxIdentities.overview>>;
const api = coreClient.admin.core["linux-identities"];
const responseError = async (response: Response): Promise<Error> => {
  const body: unknown = await response.json().catch(() => null);
  return new Error(body && typeof body === "object" && "code" in body && typeof body.code === "string" ? body.code : "error");
};

export default function LinuxIdentityPanel(props: { initial: Overview; after?: string | null }) {
  const locale = useLocale();
  const t = () => linuxMessages.resolve([locale()]).t;
  const after = () => props.after ?? null;
  const [draft, setDraft] = createSignal({ ...props.initial.config });
  const [editing, setEditing] = createSignal(props.initial.config.enabled);
  const [reserved, setReserved] = createSignal(false);
  const [selected, setSelected] = createSignal<string[]>([]);
  const [notice, setNotice] = createSignal("");
  const [progress, setProgress] = createSignal({ done: 0, total: 0 });
  let stopRequested = false;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    stopRequested = true;
  });
  const overview = query.create({
    source: after,
    initial: { source: props.after ?? null, data: props.initial },
    load: async (cursor, { abortSignal }) => {
      const response = await api.$get({ query: cursor ? { after: cursor } : {} }, { init: { signal: abortSignal } });
      if (!response.ok) throw await responseError(response);
      return response.json();
    },
  });
  const config = () => overview.data()?.config ?? props.initial.config;
  const dirty = () => JSON.stringify(draft()) !== JSON.stringify(config());
  const valid = createMemo(() => LinuxIdentityConfigurationSchema.safeParse(draft()).success);
  const change = <K extends keyof LinuxIdentityConfiguration>(key: K, value: LinuxIdentityConfiguration[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setNotice("");
    if (key === "rangeStart" || key === "rangeEnd") setReserved(false);
  };
  const save = mutation.create<void, void>({
    mutation: async () => {
      const response = await api.configuration.$put({ json: { config: draft(), rangeReserved: reserved() } });
      if (!response.ok) throw await responseError(response);
      const saved = await response.json();
      await overview.invalidate();
      setDraft(saved);
      setEditing(saved.enabled);
      setReserved(false);
      setSelected([]);
      setNotice(t().saved);
    },
  });
  const prepare = mutation.create({
    mutation: async (ids: string[]) => {
      stopRequested = false;
      setNotice("");
      setProgress({ done: 0, total: ids.length });
      try {
        for (const id of ids) {
          if (stopRequested) {
            setNotice(t().stopped);
            break;
          }
          const response = await api.users[":id"].$post({ param: { id } });
          if (!response.ok) throw await responseError(response);
          setProgress((current) => ({ ...current, done: current.done + 1 }));
          setSelected((current) => current.filter((value) => value !== id));
        }
      } finally {
        await overview.invalidate();
      }
    },
  });
  const busy = () => save.loading() || prepare.loading() || overview.refreshing();
  const begin = async () => {
    const ids = [...selected()];
    if (!ids.length || busy() || dirty()) return;
    if ((await prompts.confirm(t().confirm, { title: t().confirmTitle, confirmText: t().prepare({ count: ids.length }) })) && !disposed)
      await prepare.mutate(ids);
  };
  const errors = () => [save.error(), prepare.error(), overview.error()].filter((error): error is Error => error instanceof Error);
  const columns = (): DataTableColumn<PosixCandidate>[] => [
    { id: "select", header: t().select },
    { id: "name", header: t().name },
    { id: "source", header: t().source },
    { id: "status", header: t().status },
    { id: "identity", header: t().identity },
    { id: "home", header: t().homePreview },
  ];
  return (
    <SettingsPage title={t().title} subtitle={t().subtitle} icon="ti ti-terminal-2">
      <SettingsSection title={t().scope} subtitle={t().scopeDescription}>
        <p class="text-sm text-dimmed">{!config().enabled ? t().disabled : t().enableDescription}</p>
      </SettingsSection>
      <For each={errors()}>
        {(error) => (
          <p role="alert" class="text-sm text-red-700 dark:text-red-300">
            {linuxErrorText(error.message, t())}
          </p>
        )}
      </For>
      <Show when={notice()}>
        <p role="status" class="text-sm text-dimmed">
          {notice()}
        </p>
      </Show>
      <SettingsSection title={t().setup}>
        <Show
          when={editing()}
          fallback={
            <Button
              onClick={() => {
                setEditing(true);
                change("enabled", true);
              }}
            >
              {t().begin}
            </Button>
          }
        >
          <div class="flex flex-col gap-4">
            <CheckboxCard
              label={t().enable}
              description={t().enableDescription}
              value={draft().enabled}
              onValueChange={(value) => change("enabled", value)}
              disabled={busy()}
            />
            <Show when={draft().enabled}>
              <p class="text-sm text-dimmed">{t().defaultsDescription}</p>
              <TextInput
                label={t().home}
                description={t().homeHint}
                value={draft().homeTemplate}
                onValueChange={(value) => change("homeTemplate", value)}
                disabled={busy()}
              />
              <TextInput
                label={t().shell}
                description={t().shellHint}
                value={draft().loginShell}
                onValueChange={(value) => change("loginShell", value)}
                disabled={busy()}
              />
              <Disclosure summary={t().advanced} defaultValue={draft().rangeStart === 0 || !valid()}>
                <div class="mt-3 flex flex-col gap-3">
                  <p class="text-sm text-dimmed">{t().rangeHint}</p>
                  <div class="grid gap-3 sm:grid-cols-2">
                    <NumberInput
                      label={t().start}
                      value={draft().rangeStart || null}
                      min={1000}
                      max={2147483647}
                      onValueChange={(value) => change("rangeStart", value ?? 0)}
                      disabled={busy()}
                    />
                    <NumberInput
                      label={t().end}
                      value={draft().rangeEnd || null}
                      min={1000}
                      max={2147483647}
                      onValueChange={(value) => change("rangeEnd", value ?? 0)}
                      disabled={busy()}
                    />
                  </div>
                </div>
              </Disclosure>
              <Show when={dirty()}>
                <CheckboxCard
                  label={t().reserved}
                  description={t().reservedHint}
                  value={reserved()}
                  onValueChange={setReserved}
                  disabled={busy()}
                />
              </Show>
              <Show when={!valid()}>
                <p role="alert" class="text-sm text-red-700 dark:text-red-300">
                  {t().invalid}
                </p>
              </Show>
            </Show>
            <Show when={dirty()}>
              <div class="flex flex-wrap gap-2">
                <Button
                  disabled={busy() || !valid() || (draft().enabled && !reserved())}
                  loading={save.loading()}
                  onClick={() => void save.mutate()}
                >
                  {draft().enabled ? t().save : t().saveDisabled}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy()}
                  onClick={() => {
                    setDraft({ ...config() });
                    setEditing(config().enabled);
                    setReserved(false);
                  }}
                >
                  {t().discard}
                </Button>
              </div>
            </Show>
          </div>
        </Show>
      </SettingsSection>
      <DataPanel
        title={t().inventory}
        subtitle={t().inventoryHint}
        actions={
          <Button variant="secondary" disabled={busy()} onClick={() => void overview.refresh()}>
            {t().refresh}
          </Button>
        }
      >
        <Show when={config().enabled && !dirty()}>
          <div class="flex flex-wrap gap-2 p-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy()}
              onClick={() => setSelected((overview.data()?.items ?? []).filter((item) => item.state === "ready").map((item) => item.id))}
            >
              {t().selectPage}
            </Button>
            <Button variant="secondary" size="sm" disabled={busy() || !selected().length} onClick={() => setSelected([])}>
              {t().clear}
            </Button>
            <Button size="sm" disabled={busy() || !selected().length} onClick={() => void begin()}>
              {t().prepare({ count: selected().length })}
            </Button>
          </div>
        </Show>
        <Show when={progress().total > 0}>
          <div role="status" class="flex flex-wrap items-center gap-3 p-3 text-sm">
            {t().progress(progress())}
            <Show when={prepare.loading()}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  stopRequested = true;
                }}
              >
                {t().stop}
              </Button>
            </Show>
          </div>
        </Show>
        <DataTable
          rows={overview.data()?.items ?? []}
          columns={columns()}
          getRowId={(row) => row.id}
          class="overflow-x-auto"
          empty={t().empty}
          renderCell={({ row, col }) => {
            if (col.id === "select")
              return (
                <Show when={row.state === "ready" && config().enabled && !dirty()}>
                  <CheckboxCard
                    variant="input"
                    label={`${t().select}: ${row.uid}`}
                    value={selected().includes(row.id)}
                    disabled={busy()}
                    onValueChange={(value) =>
                      setSelected((current) => (value ? [...current, row.id] : current.filter((id) => id !== row.id)))
                    }
                  />
                </Show>
              );
            if (col.id === "name")
              return (
                <div>
                  <span class="font-medium">{row.displayName || row.uid}</span>
                  <div class="font-mono text-xs text-dimmed">{row.uid}</div>
                </div>
              );
            if (col.id === "source") return (row.identity?.managedBy ?? row.provider) === "ipa" ? "FreeIPA" : t().local;
            if (col.id === "status") return t()[row.state];
            if (col.id === "identity")
              return (
                <span class="font-mono">
                  {row.identity?.uidNumber ?? "—"} / {row.identity?.primaryGidNumber ?? "—"}
                </span>
              );
            if (col.id === "home")
              return (
                <span class="font-mono text-xs">
                  {row.identity?.homeDirectory ??
                    (row.state === "ready" && config().enabled ? config().homeTemplate.replaceAll("{username}", row.uid) : "—")}
                </span>
              );
            return "";
          }}
        />
        <Show when={!busy() && !dirty() && (after() || overview.data()?.nextCursor)}>
          <div class="flex gap-2 p-3">
            <Show when={!busy() && !dirty() && after()}>
              <ButtonLink variant="secondary" size="sm" href="/admin/settings?tab=linux">
                {t().first}
              </ButtonLink>
            </Show>
            <Show when={!busy() && !dirty() && overview.data()?.nextCursor}>
              <ButtonLink variant="secondary" size="sm" href={`/admin/settings?tab=linux&after=${overview.data()?.nextCursor}`}>
                {t().next}
              </ButtonLink>
            </Show>
          </div>
        </Show>
      </DataPanel>
    </SettingsPage>
  );
}

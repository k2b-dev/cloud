import {
  AccessLevelMenu,
  AccessRowControls,
  AccessRowFrame,
  PrincipalPicker,
  principalLabel,
  ServiceAccountSection,
  serviceAccountLevels,
  serviceAccountLine,
} from "@k2b/cloud/access/ui";
import type { Principal } from "@k2b/cloud/server";
import { query } from "@k2b/stdlib/solid";
import {
  Button,
  Disclosure,
  InlineGuidance,
  NoticeCard,
  Placeholder,
  Select,
  SettingsSection,
  StatusBadge,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { MachineOwner, MachineStorage as Storage } from "../machine-contracts";
import { apiFailure } from "./file-preview";
import { useMachineMessages } from "./machine-messages";

async function read<T>(response: { ok: boolean; json: () => Promise<T> }, fallback: string): Promise<T> {
  if (!response.ok) return apiFailure(response, fallback);
  return response.json();
}
const endpoint = apiClient.admin["machine-storage"];
export default function MachineStorage() {
  const t = useMachineMessages();
  const [owner, setOwner] = createSignal<MachineOwner>();
  const [after, setAfter] = createSignal<string>();
  const [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal<string>(),
    [saved, setSaved] = createSignal(false);
  const list = query.create({
    source: after,
    load: async (cursor, { abortSignal }) =>
      read(await endpoint.$get({ query: { after: cursor } }, { init: { signal: abortSignal } }), t().failed),
  });
  const create = async () => {
    const selected = owner();
    if (!selected || busy()) return;
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      await read(await endpoint.$post({ json: { ownerId: selected.id, area: "cloud" } }), t().actionFailed);
      setOwner(undefined);
      setSaved(true);
      setAfter(undefined);
      await list.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t().actionFailed);
      // Reconcile an uncertain response with the canonical list before offering another change.
      await list.refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection title={t().title} subtitle={t().detail} icon="ti ti-server">
      <NoticeCard tone="info" title={t().owner} detail={t().cloud} />
      <div class="flex min-w-0 flex-col gap-3">
        <div class="flex flex-col gap-2">
          <span class="text-sm font-medium">{t().choose}</span>
          <PrincipalPicker
            serviceAccountKinds={["standalone", "agent"]}
            allowPublic={false}
            allowAuthenticated={false}
            allowServiceAccounts={true}
            disabled={busy()}
            onSelect={(principal, display) => {
              if (
                principal.type !== "service_account" ||
                !display.serviceAccountKind ||
                !["agent", "standalone"].includes(display.serviceAccountKind)
              ) {
                setError(t().wrongOwner);
                return;
              }
              setOwner({
                id: principal.serviceAccountId,
                name: display.displayName,
                kind: display.serviceAccountKind === "agent" ? "agent" : "standalone",
              });
              setError(undefined);
            }}
          />
        </div>
        <Show when={owner()}>
          {(selected) => (
            <div class="flex flex-wrap items-center gap-2">
              <span>{selected().name}</span>
              <StatusBadge tone="neutral" label={selected().kind === "agent" ? t().agent : t().standalone} />
            </div>
          )}
        </Show>
        <div>
          <Button type="button" disabled={!owner()} loading={busy()} onClick={() => void create()}>
            {t().create}
          </Button>
        </div>
        <Show when={error()}>
          {(message) => (
            <InlineGuidance tone="danger" role="alert">
              {message()}
            </InlineGuidance>
          )}
        </Show>
        <Show when={saved()}>
          <InlineGuidance tone="success" role="status">
            {t().saved}
          </InlineGuidance>
        </Show>
        <InlineGuidance tone="info">{t().provisioning}</InlineGuidance>
        <Show when={!list.loading()} fallback={<Placeholder state="loading" title={t().loading} />}>
          <Show
            when={!list.error()}
            fallback={
              <Placeholder
                state="error"
                title={t().failed}
                description={list.error()?.message === t().failed ? undefined : list.error()?.message}
                action={
                  <Button type="button" onClick={() => void list.refresh()}>
                    {t().retry}
                  </Button>
                }
              />
            }
          >
            <Show when={list.data()?.items.length} fallback={<Placeholder title={t().empty} description={t().emptyDetail} />}>
              <For each={list.data()?.items}>
                {(storage) => (
                  <Disclosure
                    summary={
                      <span class="inline-flex flex-wrap items-center gap-2">
                        {storage.owner.name}
                        <StatusBadge tone="neutral" label={storage.owner.kind === "agent" ? t().agent : t().standalone} />
                      </span>
                    }
                  >
                    <div class="flex min-w-0 flex-col gap-3">
                      <span class="text-sm text-dimmed">
                        {t().state}: {storage.state === "active" ? t().active : t().pending}
                      </span>
                      <StorageGrants storage={storage} />
                    </div>
                  </Disclosure>
                )}
              </For>
            </Show>
            <div class="flex flex-wrap gap-2">
              <Show when={after()}>
                <Button type="button" variant="secondary" onClick={() => setAfter(undefined)}>
                  {t().first}
                </Button>
              </Show>
              <Show when={list.data()?.next}>
                {(next) => (
                  <Button type="button" variant="secondary" onClick={() => setAfter(next())}>
                    {t().more}
                  </Button>
                )}
              </Show>
            </div>
          </Show>
        </Show>
      </div>
    </SettingsSection>
  );
}
function StorageGrants(props: { storage: Storage }) {
  const t = useMachineMessages(),
    locale = useLocale();
  const [path, setPath] = createSignal(""),
    [permission, setPermission] = createSignal<"read" | "write" | "admin">("read");
  const [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal<string>();
  const [after, setAfter] = createSignal<string>();
  const grants = query.create({
    source: () => ({ id: props.storage.id, after: after() }),
    load: async ({ id, after }, { abortSignal }) =>
      read(await endpoint[":id"].grants.$get({ param: { id }, query: { after } }, { init: { signal: abortSignal } }), t().failed),
  });
  const run = async (work: () => Promise<unknown>) => {
    if (busy()) return false;
    setBusy(true);
    setError(undefined);
    try {
      await work();
      await grants.refresh();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t().actionFailed);
      await grants.refresh().catch(() => undefined);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const grant = (principal: Principal, level = permission(), at = path()) =>
    run(async () => read(await endpointResponse(principal, level, at), t().actionFailed));
  async function endpointResponse(principal: Principal, level: "read" | "write" | "admin", at: string) {
    if (principal.type !== "user" && principal.type !== "group" && principal.type !== "service_account") throw new Error(t().actionFailed);
    return endpoint[":id"].grants.$post({ param: { id: props.storage.id }, json: { principal, path: at, permission: level } });
  }
  const revoke = (accessId: string) =>
    run(async () =>
      read(await endpoint[":id"].grants[":accessId"].$delete({ param: { id: props.storage.id, accessId } }), t().actionFailed),
    );
  type Grant = NonNullable<ReturnType<typeof grants.data>>["items"][number];
  /** Code accounts list in Service accounts, as in every share dialog; everyone else stays with the folder grants. */
  const accountGrants = () => grants.data()?.items.filter((entry) => entry.serviceAccountKind === "code") ?? [];
  const folderGrants = () => grants.data()?.items.filter((entry) => entry.serviceAccountKind !== "code") ?? [];
  /** A service account's levels in the words of every share dialog: View and Edit. */
  const accountLevels = () => serviceAccountLevels(locale());
  const levelLabel = (level: string) => accountLevels().find((option) => option.level === level)?.label ?? level;
  const AccountRow = (rowProps: { entry: Grant }) => {
    const entry = () => rowProps.entry;
    const name = () => principalLabel(entry(), locale());
    const remove = (control: HTMLElement) => {
      const section = control.closest("section");
      void revoke(entry().id).then((removed) => {
        // The row leaves; focus goes to "Add service account" instead of the page.
        if (removed) queueMicrotask(() => section?.querySelector<HTMLButtonElement>("header button")?.focus());
      });
    };
    return (
      <AccessRowFrame
        rowKey={entry().id}
        avatar={{ principal: entry().principal, avatarHash: entry().avatarHash, serviceAccountKind: entry().serviceAccountKind }}
        name={name()}
        href={entry().serviceAccountHref}
        // The line the dialog shows, then the path this grant covers.
        line={`${serviceAccountLine(locale(), { description: entry().serviceAccountDescription, level: levelLabel(entry().permission) })} · ${entry().path || "/"}`}
        wrapLine
        end={
          <AccessRowControls
            name={name()}
            menu={
              <AccessLevelMenu
                name={name()}
                value={entry().permission}
                valueLabel={levelLabel(entry().permission)}
                options={accountLevels()}
                onChange={(value) => {
                  if ((value !== "read" && value !== "write") || value === entry().permission) return;
                  const id = entry().id;
                  void grant(entry().principal, value, entry().path).then(() =>
                    // Saving disabled the level; focus returns there unless the person moved on.
                    queueMicrotask(() => {
                      if (document.activeElement && document.activeElement !== document.body) return;
                      document.querySelector<HTMLButtonElement>(`li[data-access-key="${id}"] button[aria-haspopup]`)?.focus();
                    }),
                  );
                }}
                disabled={busy()}
                onRemove={remove}
                removeDisabled={busy()}
              />
            }
            removeDisabled={busy()}
            onRemove={remove}
          />
        }
      />
    );
  };
  return (
    <div class="flex min-w-0 flex-col gap-3">
      <span class="font-medium">{t().grants}</span>
      <Show when={!grants.loading()} fallback={<Placeholder state="loading" title={t().loading} />}>
        <Show
          when={!grants.error()}
          fallback={
            <Placeholder
              state="error"
              title={t().failed}
              action={
                <Button type="button" onClick={() => void grants.refresh()}>
                  {t().retry}
                </Button>
              }
            />
          }
        >
          <Show when={grants.data()?.items.length} fallback={<Placeholder title={t().noGrants} description={t().noGrantsDetail} />}>
            <For each={folderGrants()}>
              {(entry) => (
                <div class="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded border border-subtle p-3">
                  <div class="min-w-0">
                    <div class="break-words">{principalLabel(entry, locale())}</div>
                    <div class="break-all text-sm text-dimmed">
                      {entry.path || "/"} · {t()[entry.permission === "admin" ? "admin" : entry.permission === "write" ? "write" : "read"]}
                    </div>
                    <Show when={entry.serviceAccountKind}>
                      <StatusBadge tone="neutral" label={entry.serviceAccountKind === "agent" ? t().agent : t().standalone} />
                    </Show>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    loading={busy()}
                    onClick={() =>
                      void run(async () =>
                        read(
                          await endpoint[":id"].grants[":accessId"].$delete({ param: { id: props.storage.id, accessId: entry.id } }),
                          t().actionFailed,
                        ),
                      )
                    }
                  >
                    {t().revoke}
                  </Button>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </Show>
      <div class="flex flex-wrap gap-2">
        <Show when={after()}>
          <Button type="button" variant="secondary" onClick={() => setAfter(undefined)}>
            {t().first}
          </Button>
        </Show>
        <Show when={grants.data()?.next}>
          {(next) => (
            <Button type="button" variant="secondary" onClick={() => setAfter(next())}>
              {t().more}
            </Button>
          )}
        </Show>
      </div>
      <TextInput label={t().path} value={path()} onValueChange={setPath} description={t().pathHint} disabled={busy()} />
      <Select
        label={t().level}
        value={permission()}
        onValueChange={(value) => {
          if (value === "read" || value === "write" || value === "admin") setPermission(value);
        }}
        options={[
          { value: "read", label: t().read },
          { value: "write", label: t().write },
          { value: "admin", label: t().admin },
        ]}
        disabled={busy()}
      />
      <span class="text-sm font-medium">{t().grant}</span>
      <PrincipalPicker
        target={{ type: "filesv2.storage", id: props.storage.id }}
        allowPublic={false}
        allowAuthenticated={false}
        allowServiceAccounts={true}
        disabled={busy()}
        onSelect={(principal, display) =>
          // A handle typed into the search finds the service account too; it joins its own section below.
          void grant(principal, display.serviceAccountKind === "code" && permission() === "admin" ? "write" : permission())
        }
      />
      {/* As in every share dialog: service accounts have their own section, added by handle, with their own rows. */}
      <ServiceAccountSection
        target={{ type: "filesv2.storage", id: props.storage.id }}
        resourceName={t().storageName({ owner: props.storage.owner.name })}
        count={accountGrants().length}
        hasRows={accountGrants().length > 0}
        disabled={busy()}
        // Manage is never offered to a service account, so the level chosen above stops at write.
        add={(account) => grant(account.principal, permission() === "admin" ? "write" : permission())}
      >
        {/* Rows are keyed by grant, so a saved change keeps the row, its controls and the focus. */}
        <For each={accountGrants().map((entry) => entry.id)}>
          {(id) => <Show when={accountGrants().find((entry) => entry.id === id)}>{(entry) => <AccountRow entry={entry()} />}</Show>}
        </For>
      </ServiceAccountSection>
      <Show when={busy()}>
        <InlineGuidance role="status">{t().loading}</InlineGuidance>
      </Show>
      <Show when={error()}>
        {(message) => (
          <InlineGuidance tone="danger" role="alert">
            {message()}
          </InlineGuidance>
        )}
      </Show>
    </div>
  );
}

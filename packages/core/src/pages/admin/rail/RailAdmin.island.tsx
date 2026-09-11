import { PermissionEditor } from "@k2b/cloud/access/ui";
import { coreClient } from "@k2b/cloud/clients/core";
import { RailAccessSchema, RailAdminInputSchema, RailAdminSchema, type RailAdminEntry, type RailAdminState } from "@k2b/cloud/contracts";
import type { RailShortcut } from "@k2b/cloud/contracts";
import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import {
  Button,
  CheckboxCard,
  DataTable,
  type DataTableColumn,
  confirmDiscardIfDirty,
  dialogCore,
  IconButton,
  IconInput,
  NoticeCard,
  PanelDialog,
  panelDialogOptions,
  prompts,
  Select,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createSignal, onCleanup, Show } from "solid-js";
import { railAdminMessages } from "./messages";

type AppOption = { id: string; label: string; icon: string };
type Copy = ReturnType<typeof railAdminMessages.resolve>["t"];
const persist = async (value: RailAdminState, signal: AbortSignal, t: Copy) => {
  const response = await coreClient.admin.core.rail.$put({ json: RailAdminInputSchema.parse(value) }, { init: { signal } });
  if (!response.ok) throw new Error(response.status === 409 ? t.conflict : t.error);
  return RailAdminSchema.parse(await response.json());
};

const everyoneAccess = () =>
  RailAccessSchema.parse({
    id: crypto.randomUUID(),
    principal: { type: "authenticated" },
    permission: "read",
    createdAt: new Date().toISOString(),
  });

function Editor(props: {
  initial: RailAdminEntry;
  state: RailAdminState;
  apps: AppOption[];
  close: () => void;
  setDismissHandler: (handler: () => void | Promise<void>) => void;
  saved: (state: RailAdminState) => void;
}) {
  const locale = useLocale();
  const t = () => railAdminMessages.resolve([locale()]).t;
  const [entry, setEntry] = createSignal(structuredClone(props.initial));
  const initiallyRestricted = !props.initial.access.some((access) => access.principal.type === "authenticated");
  const [restricted, setRestricted] = createSignal(initiallyRestricted);
  const authenticated = props.initial.access.find((access) => access.principal.type === "authenticated") ?? everyoneAccess();
  const effectiveEntry = (): RailAdminEntry => ({
    ...entry(),
    access: restricted() ? entry().access.filter((access) => access.principal.type !== "authenticated") : [authenticated],
  });
  const dirty = () => restricted() !== initiallyRestricted || JSON.stringify(entry()) !== JSON.stringify(props.initial);
  const candidate = (): RailAdminState => {
    const exists = props.state.entries.some((item) => item.shortcut.id === entry().shortcut.id);
    return {
      ...props.state,
      entries: exists
        ? props.state.entries.map((item) => (item.shortcut.id === entry().shortcut.id ? effectiveEntry() : item))
        : [...props.state.entries, effectiveEntry()],
    };
  };
  const valid = () => RailAdminInputSchema.safeParse(candidate()).success;
  const save = mutation.create({
    mutation: (value: RailAdminState, { abortSignal }) => persist(value, abortSignal, t()),
    onSuccess: (state) => {
      props.saved(state);
      props.close();
      void refreshCurrentPath();
    },
  });
  onCleanup(save.abort);
  const close = async () => {
    if (!save.loading() && (await confirmDiscardIfDirty(dirty))) props.close();
  };
  props.setDismissHandler(close);
  const updateShortcut = (shortcut: RailShortcut) => setEntry((value) => ({ ...value, shortcut }));
  const link = () => {
    const shortcut = entry().shortcut;
    return shortcut.kind === "link" ? shortcut : undefined;
  };
  const updateLink = (changes: Partial<Extract<RailShortcut, { kind: "link" }>>) => {
    const current = link();
    if (current) updateShortcut({ ...current, ...changes });
  };
  return (
    <PanelDialog>
      <PanelDialog.Header title={t().edit} icon="ti ti-layout-sidebar" close={close} closeDisabled={save.loading()} />
      <PanelDialog.Body>
        <fieldset disabled={save.loading()} class="flex min-w-0 flex-col gap-4">
          <Select
            label={t().type}
            value={() => entry().shortcut.kind}
            clearable={false}
            options={[
              { id: "app", label: t().app },
              { id: "link", label: t().link },
            ]}
            onValueChange={(kind) => {
              if (kind === entry().shortcut.kind) return;
              if (kind === "app") updateShortcut({ id: entry().shortcut.id, kind, appId: props.apps[0]?.id ?? "" });
              if (kind === "link") updateShortcut({ id: entry().shortcut.id, kind, title: "", href: "", icon: "ti ti-link" });
            }}
          />
          <Show
            when={entry().shortcut.kind === "app"}
            fallback={
              <>
                <TextInput
                  label={t().name}
                  value={() => link()?.title ?? ""}
                  required
                  maxLength={80}
                  onValueChange={(title) => updateLink({ title })}
                />
                <TextInput
                  label={t().url}
                  description={t().urlHint}
                  value={() => link()?.href ?? ""}
                  required
                  maxLength={2000}
                  onValueChange={(href) => updateLink({ href })}
                />
                <IconInput
                  label={t().icon}
                  value={() => link()?.icon ?? "ti ti-link"}
                  clearable={false}
                  onValueChange={(icon) => updateLink({ icon: icon ?? "ti ti-link" })}
                />
              </>
            }
          >
            <Select
              label={t().app}
              placeholder={t().chooseApp}
              options={props.apps}
              clearable={false}
              searchable
              value={() => {
                const shortcut = entry().shortcut;
                return shortcut.kind === "app" ? shortcut.appId : null;
              }}
              onValueChange={(appId) => {
                if (appId) updateShortcut({ id: entry().shortcut.id, kind: "app", appId });
              }}
            />
          </Show>
          <CheckboxCard
            label={t().restrictAudience}
            description={t().restrictAudienceHint}
            value={restricted()}
            onValueChange={setRestricted}
            disabled={save.loading()}
          />
          <Show when={restricted()}>
            <PanelDialog.Section title={t().audience} icon="ti ti-users">
              <p class="text-xs text-dimmed">{t().audienceHint}</p>
              <PermissionEditor
                initialEntries={entry().access.filter((access) => access.principal.type !== "authenticated")}
                canEdit={!save.loading()}
                allowPublic={false}
                allowAuthenticated={false}
                allowServiceAccounts={false}
                allowedLevels={[{ level: "read", label: t().show }]}
                grantAccess={async (principal, permission, display) => {
                  const access = RailAccessSchema.parse({
                    id: crypto.randomUUID(),
                    principal,
                    permission,
                    createdAt: new Date().toISOString(),
                    displayName: display?.displayName,
                  });
                  setEntry((value) => ({ ...value, access: [...value.access, access] }));
                  return access;
                }}
                updateAccess={async () => {
                  /* The only offered level is read. */
                }}
                revokeAccess={async (id) => {
                  setEntry((value) => ({ ...value, access: value.access.filter((access) => access.id !== id) }));
                }}
              />
            </PanelDialog.Section>
          </Show>
        </fieldset>
        <Show when={!valid()}>
          <NoticeCard tone="warning">{t().invalid}</NoticeCard>
        </Show>
        <Show when={save.error()}>{(error) => <NoticeCard tone="danger">{error().message}</NoticeCard>}</Show>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button disabled={!valid()} loading={save.loading()} loadingLabel={t().saving} onClick={() => void save.mutate(candidate())}>
          {t().save}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export default function RailAdmin(props: { initial: RailAdminState; apps: AppOption[] }) {
  const locale = useLocale();
  const t = () => railAdminMessages.resolve([locale()]).t;
  const [state, setState] = createSignal(props.initial);
  const save = mutation.create({
    mutation: (value: RailAdminState, { abortSignal }) => persist(value, abortSignal, t()),
    onSuccess: (value) => {
      setState(value);
      void refreshCurrentPath();
    },
  });
  const clearCache = mutation.create({
    mutation: async (_: void, { abortSignal }) => {
      const response = await coreClient.admin.core.rail.cache.$delete({}, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(t().cacheError);
    },
    onSuccess: () => {
      toast.success(t().cacheCleared);
    },
  });
  onCleanup(() => {
    save.abort();
    clearCache.abort();
  });
  const edit = (initial: RailAdminEntry) =>
    void dialogCore.open<void>(
      (close, dialog) => (
        <Editor
          initial={initial}
          state={state()}
          apps={props.apps}
          close={close}
          setDismissHandler={dialog.setDismissHandler}
          saved={setState}
        />
      ),
      { ...panelDialogOptions, ariaLabel: t().edit },
    );
  const move = (index: number, offset: number) => {
    const entries = [...state().entries];
    const [item] = entries.splice(index, 1);
    if (!item) return;
    entries.splice(index + offset, 0, item);
    void save.mutate({ ...state(), entries });
  };
  const remove = async (id: string) => {
    if (await prompts.confirm(t().deleteConfirm))
      void save.mutate({ ...state(), entries: state().entries.filter((entry) => entry.shortcut.id !== id) });
  };
  const columns = (): DataTableColumn<RailAdminEntry>[] => [
    { id: "name", header: t().name },
    { id: "type", header: t().type },
    { id: "target", header: t().target },
    { id: "audience", header: t().audience },
    { id: "actions", header: <span class="sr-only">{t().actions}</span>, cellClass: "text-right whitespace-nowrap max-w-none" },
  ];
  return (
    <section class="flex min-w-0 flex-col gap-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0">
          <h1 class="text-base font-semibold text-primary">{t().title}</h1>
          <p class="mt-1 text-xs text-dimmed">{t().description}</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={save.loading()}
          onClick={() =>
            edit({
              shortcut: { id: crypto.randomUUID(), kind: "link", title: "", href: "", icon: "ti ti-link" },
              access: [everyoneAccess()],
            })
          }
        >
          <i class="ti ti-plus" aria-hidden="true" />
          {t().add}
        </Button>
      </div>
      <NoticeCard tone="info" title={t().cacheTitle} detail={t().cacheHint}>
        <div class="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" loading={clearCache.loading()} onClick={() => void clearCache.mutate(undefined)}>
            <i class="ti ti-refresh" aria-hidden="true" />
            {t().clearCache}
          </Button>
        </div>
      </NoticeCard>
      <Show when={clearCache.error()}>
        {(error) => (
          <NoticeCard tone="danger" role="alert">
            {error().message}
          </NoticeCard>
        )}
      </Show>
      <DataTable
        rows={state().entries}
        columns={columns()}
        getRowId={(row) => row.shortcut.id}
        hoverRows
        highlightColumns={false}
        class="paper overflow-x-auto"
        tableClass="w-full text-sm"
        empty={t().empty}
        renderCell={({ row: entry, col }) => {
          const shortcut = entry.shortcut;
          const app = shortcut.kind === "app" ? props.apps.find((app) => app.id === shortcut.appId) : undefined;
          const index = () => state().entries.findIndex((item) => item.shortcut.id === shortcut.id);
          if (col.id === "name")
            return (
              <div class="flex items-center gap-2 text-xs font-medium text-primary">
                <i class={shortcut.kind === "app" ? (app?.icon ?? "ti ti-apps") : shortcut.icon} aria-hidden="true" />
                <span>{shortcut.kind === "app" ? (app?.label ?? t().unavailable) : shortcut.title}</span>
              </div>
            );
          if (col.id === "type") return <span class="text-xs text-secondary">{shortcut.kind === "app" ? t().app : t().link}</span>;
          if (col.id === "target")
            return (
              <span class="block max-w-sm truncate text-xs text-dimmed" title={shortcut.kind === "app" ? shortcut.appId : shortcut.href}>
                {shortcut.kind === "app" ? shortcut.appId : shortcut.href}
              </span>
            );
          if (col.id === "audience")
            return (
              <span class="text-xs text-secondary">
                {entry.access.some((access) => access.principal.type === "authenticated")
                  ? t().everyone
                  : entry.access.length
                    ? t().selected({ count: entry.access.length })
                    : t().nobody}
              </span>
            );
          if (col.id === "actions")
            return (
              <div class="flex items-center justify-end gap-1">
                <IconButton label={t().up} disabled={save.loading() || index() === 0} onClick={() => move(index(), -1)}>
                  <i class="ti ti-arrow-up" />
                </IconButton>
                <IconButton
                  label={t().down}
                  disabled={save.loading() || index() === state().entries.length - 1}
                  onClick={() => move(index(), 1)}
                >
                  <i class="ti ti-arrow-down" />
                </IconButton>
                <IconButton label={t().edit} disabled={save.loading()} onClick={() => edit(entry)}>
                  <i class="ti ti-pencil" />
                </IconButton>
                <IconButton label={t().remove} disabled={save.loading()} onClick={() => void remove(shortcut.id)}>
                  <i class="ti ti-trash" />
                </IconButton>
              </div>
            );
          return "";
        }}
      />
      <Show when={save.error()}>{(error) => <NoticeCard tone="danger">{error().message}</NoticeCard>}</Show>
    </section>
  );
}

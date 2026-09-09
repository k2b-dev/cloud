import { mutation, query } from "@k2b/stdlib/solid";
import {
  Button,
  Checkbox,
  confirmDiscardIfDirty,
  dialogCore,
  IconButton,
  IconInput,
  NoticeCard,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  Select,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, Index, onCleanup, Show } from "solid-js";
import { coreClient } from "../clients/core";
import { type RailPreferences, RailPreferencesSchema, type RailShortcut } from "../contracts/rail-preferences";
import { publishRailPreferences, readRailContext } from "./rail-context";
import { railMessages } from "./rail-messages";
import { isRailAppVisible, type RailApp, sortRailApps } from "./rail-navigation";

export const readRailPreferences = async (signal: AbortSignal, message: string) => {
  const response = await coreClient.me.rail.$get({}, { init: { signal } });
  if (!response.ok) throw new Error(message);
  return RailPreferencesSchema.parse(await response.json());
};

type RailDialogProps = { apps: RailApp[]; close: () => void; setDismissHandler: (handler: () => void | Promise<void>) => void };

function RailEditorForm(props: RailDialogProps & { initial: RailPreferences }) {
  const locale = useLocale();
  const t = () => railMessages.resolve([locale()]).t;
  const [settings, setSettings] = createSignal<RailPreferences>(structuredClone(props.initial));
  const valid = createMemo(() => RailPreferencesSchema.safeParse(settings()).success);
  const dirty = () => JSON.stringify(settings()) !== JSON.stringify(props.initial);
  const pinned = () => new Set(settings().shortcuts.flatMap((entry) => (entry.kind === "app" ? [entry.appId] : [])));
  const appOptions = () => props.apps.map((app) => ({ id: app.id, label: app.label, icon: app.iconClass }));
  const nextApp = () => props.apps.find((app) => !pinned().has(app.id));
  const updateShortcut = (index: number, next: RailShortcut) =>
    setSettings((value) => ({ ...value, shortcuts: value.shortcuts.map((entry, i) => (i === index ? next : entry)) }));
  const move = (index: number, offset: number) =>
    setSettings((value) => {
      const shortcuts = [...value.shortcuts];
      const [entry] = shortcuts.splice(index, 1);
      if (entry) shortcuts.splice(index + offset, 0, entry);
      return { ...value, shortcuts };
    });
  const add = (shortcut: RailShortcut) => setSettings((value) => ({ ...value, shortcuts: [...value.shortcuts, shortcut] }));
  const save = mutation.create({
    mutation: async (value: RailPreferences, { abortSignal }) => {
      const response = await coreClient.me.rail.$put({ json: value }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(response.status === 409 ? t().conflict : t().saveFailed);
      // Core returns the canonical database row; publish it without a second request that could fail after saving.
      return RailPreferencesSchema.parse(await response.json());
    },
    onSuccess: (value) => {
      publishRailPreferences(value);
      props.close();
    },
  });
  onCleanup(save.abort);
  const requestClose = async () => {
    if (save.loading()) return;
    if (await confirmDiscardIfDirty(dirty)) props.close();
  };
  props.setDismissHandler(requestClose);
  return (
    <PanelDialog>
      <PanelDialog.Header
        title={t().customize}
        subtitle={t().description}
        icon="ti ti-layout-sidebar"
        close={requestClose}
        closeDisabled={save.loading()}
      />
      <PanelDialog.Body>
        <fieldset disabled={save.loading()} class="flex min-h-0 flex-col gap-4">
          <PanelDialog.Section title={t().apps} icon="ti ti-apps">
            <div
              style={{ display: "grid", "grid-template-columns": "repeat(auto-fit, minmax(min(100%, 13rem), 1fr))", gap: "0.75rem 1.5rem" }}
            >
              <For each={props.apps}>
                {(app) => (
                  <Checkbox
                    label={app.label}
                    description={pinned().has(app.id) ? t().pinned : undefined}
                    disabled={save.loading() || pinned().has(app.id)}
                    value={() => pinned().has(app.id) || isRailAppVisible(app, settings())}
                    onValueChange={(visible) =>
                      setSettings((value) => {
                        const visibility = { ...value.visibility };
                        if (visible === app.defaultVisible) delete visibility[app.id];
                        else visibility[app.id] = visible;
                        return { ...value, visibility };
                      })
                    }
                  />
                )}
              </For>
            </div>
          </PanelDialog.Section>
          <PanelDialog.Section title={t().shortcuts} icon="ti ti-link">
            <div class="flex flex-col gap-3">
              <Show when={settings().shortcuts.length === 0}>
                <Placeholder description={t().empty} align="left" />
              </Show>
              <Index each={settings().shortcuts}>
                {(shortcut, index) => {
                  const app = () => {
                    const entry = shortcut();
                    return entry.kind === "app" ? props.apps.find((app) => app.id === entry.appId) : undefined;
                  };
                  const link = () => {
                    const entry = shortcut();
                    return entry.kind === "link" ? entry : undefined;
                  };
                  const updateLink = (changes: Partial<Extract<RailShortcut, { kind: "link" }>>) => {
                    const entry = link();
                    if (entry) updateShortcut(index, { ...entry, ...changes });
                  };
                  return (
                    <div class="rounded-lg border border-[var(--ui-border)] p-3 flex flex-col gap-3">
                      <div class="flex items-center gap-1">
                        <span class="min-w-0 flex-1 truncate text-sm font-medium">
                          {index + 1}. {app()?.label ?? link()?.title ?? t().unavailable}
                        </span>
                        <IconButton label={t().up} size="sm" disabled={save.loading() || index === 0} onClick={() => move(index, -1)}>
                          <i class="ti ti-arrow-up" />
                        </IconButton>
                        <IconButton
                          label={t().down}
                          size="sm"
                          disabled={save.loading() || index === settings().shortcuts.length - 1}
                          onClick={() => move(index, 1)}
                        >
                          <i class="ti ti-arrow-down" />
                        </IconButton>
                        <IconButton
                          label={t().remove}
                          size="sm"
                          disabled={save.loading()}
                          onClick={() => setSettings((value) => ({ ...value, shortcuts: value.shortcuts.filter((_, i) => i !== index) }))}
                        >
                          <i class="ti ti-trash" />
                        </IconButton>
                      </div>
                      <Show
                        when={shortcut().kind === "app"}
                        fallback={
                          <>
                            <TextInput
                              label={t().title}
                              value={() => link()?.title ?? ""}
                              maxLength={80}
                              required
                              onValueChange={(title) => updateLink({ title })}
                            />
                            <TextInput
                              label={t().url}
                              value={() => link()?.href ?? ""}
                              maxLength={2000}
                              required
                              description={t().urlHint}
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
                          value={() => {
                            const entry = shortcut();
                            return entry.kind === "app" ? entry.appId : null;
                          }}
                          options={appOptions()}
                          clearable={false}
                          searchable
                          onValueChange={(appId) => {
                            if (appId) updateShortcut(index, { id: shortcut().id, kind: "app", appId });
                          }}
                        />
                      </Show>
                    </div>
                  );
                }}
              </Index>
              <div class="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!nextApp()}
                  onClick={() => {
                    const app = nextApp();
                    if (app) add({ id: crypto.randomUUID(), kind: "app", appId: app.id });
                  }}
                >
                  {t().addApp}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => add({ id: crypto.randomUUID(), kind: "link", title: "", href: "", icon: "ti ti-link" })}
                >
                  {t().addLink}
                </Button>
              </div>
            </div>
          </PanelDialog.Section>
        </fieldset>
        <Show when={!valid()}>
          <NoticeCard tone="warning">{t().invalid}</NoticeCard>
        </Show>
        <Show when={save.error()}>{(error) => <NoticeCard tone="danger">{error().message}</NoticeCard>}</Show>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <div class="flex w-full flex-wrap items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={save.loading()}
            onClick={() => setSettings({ revision: props.initial.revision, visibility: {}, shortcuts: [] })}
          >
            {t().reset}
          </Button>
          <Button
            size="sm"
            disabled={!valid() || !dirty()}
            loading={save.loading()}
            loadingLabel={t().saving}
            onClick={() => void save.mutate(settings())}
          >
            {t().save}
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

function RailEditor(props: RailDialogProps) {
  const locale = useLocale();
  const t = () => railMessages.resolve([locale()]).t;
  const settings = query.create({ source: () => "rail", load: (_, { abortSignal }) => readRailPreferences(abortSignal, t().loadFailed) });
  return (
    <>
      <Show
        when={settings.data()}
        fallback={
          <PanelDialog>
            <PanelDialog.Header title={t().customize} icon="ti ti-layout-sidebar" close={props.close} />
            <PanelDialog.Body>
              <Placeholder
                state={settings.loading() ? "loading" : "error"}
                description={settings.loading() ? t().loading : t().loadFailed}
                action={
                  <Show when={!settings.loading() && settings.error()}>
                    <Button size="sm" onClick={() => void settings.refresh()}>
                      {t().retry}
                    </Button>
                  </Show>
                }
              />
            </PanelDialog.Body>
          </PanelDialog>
        }
      >
        {(initial) => (
          <RailEditorForm apps={props.apps} initial={initial()} close={props.close} setDismissHandler={props.setDismissHandler} />
        )}
      </Show>
    </>
  );
}

export const openRailEditor = (locale: string) => {
  const context = readRailContext();
  if (!context) return;
  void dialogCore.open<void>(
    (close, dialog) => <RailEditor apps={sortRailApps(context.apps, locale)} close={close} setDismissHandler={dialog.setDismissHandler} />,
    {
      ...panelDialogOptions,
      ariaLabel: railMessages.resolve([locale]).t.customize,
    },
  );
};

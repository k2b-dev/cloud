import { mutation, query } from "@k2b/stdlib/solid";
import { Button, IconButton, IconInput, NoticeCard, Placeholder, prompts, Select, Switch, TextInput, useLocale } from "@k2b/ui";
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

function RailEditorForm(props: { apps: RailApp[]; initial: RailPreferences; close: () => void }) {
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
  return (
    <div class="flex min-h-0 flex-col gap-4">
      <p class="text-sm text-dimmed">{t().description}</p>
      <fieldset disabled={save.loading()} class="flex min-h-0 flex-col gap-6">
        <section class="flex flex-col gap-3" aria-label={t().apps}>
          <h3 class="font-medium">{t().apps}</h3>
          <For each={props.apps}>
            {(app) => (
              <Switch
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
        </section>
        <section class="flex flex-col gap-3" aria-label={t().shortcuts}>
          <h3 class="font-medium">{t().shortcuts}</h3>
          <Show when={settings().shortcuts.length === 0}>
            <p class="text-sm text-dimmed">{t().empty}</p>
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
        </section>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setSettings({ revision: props.initial.revision, visibility: {}, shortcuts: [] })}
        >
          {t().reset}
        </Button>
      </fieldset>
      <Show when={!valid()}>
        <NoticeCard tone="warning">{t().invalid}</NoticeCard>
      </Show>
      <Show when={save.error()}>{(error) => <NoticeCard tone="danger">{error().message}</NoticeCard>}</Show>
      <div class="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 bg-[var(--ui-dialog-surface)] py-2">
        <Show when={dirty()}>
          <span class="mr-auto text-xs text-dimmed">{t().unsaved}</span>
        </Show>
        <Button
          disabled={!valid() || !dirty()}
          loading={save.loading()}
          loadingLabel={t().saving}
          onClick={() => void save.mutate(settings())}
        >
          {t().save}
        </Button>
      </div>
    </div>
  );
}

function RailEditor(props: { apps: RailApp[]; close: () => void }) {
  const locale = useLocale();
  const t = () => railMessages.resolve([locale()]).t;
  const settings = query.create({ source: () => "rail", load: (_, { abortSignal }) => readRailPreferences(abortSignal, t().loadFailed) });
  return (
    <>
      <Show
        when={settings.data()}
        fallback={
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
        }
      >
        {(initial) => <RailEditorForm apps={props.apps} initial={initial()} close={props.close} />}
      </Show>
    </>
  );
}

export const openRailEditor = (locale: string) => {
  const context = readRailContext();
  if (!context) return;
  void prompts.dialog<void>((close) => <RailEditor apps={sortRailApps(context.apps, locale)} close={close} />, {
    title: railMessages.resolve([locale]).t.customize,
    size: "large",
  });
};

/** Direct entry point for Cloud surfaces, separate from their own editors. */
export function RailEditorButton() {
  const locale = useLocale();
  return (
    <Button variant="secondary" size="sm" onClick={() => openRailEditor(locale())}>
      <i class="ti ti-layout-sidebar" />
      {railMessages.resolve([locale()]).t.customize}
    </Button>
  );
}

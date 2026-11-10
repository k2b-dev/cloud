import { query } from "@k2b/stdlib/solid";
import {
  BottomSheet,
  Button,
  bottomSheetAdaptiveOptions,
  dialogCore,
  IconButton,
  IconInput,
  NoticeCard,
  Placeholder,
  SortableList,
  Switch,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createSignal, For, type JSX, Show } from "solid-js";
import { coreClient } from "../clients/core";
import { isRailShortcutHref, type RailPreferences, RailPreferencesSchema, type RailShortcut } from "../contracts/rail-preferences";
import { appIconStyle } from "./app-icon-style";
import { publishRailPreferences, readRailContext } from "./rail-context";
import { createRailSaver, type RailEdit, type RailSaveResult, type RailSaver } from "./rail-editor-model";
import { railMessages } from "./rail-messages";
import { projectRailNavigation, type RailApp, sortRailApps } from "./rail-navigation";
import { readShellData } from "./shell-data";

type LinkShortcut = Extract<RailShortcut, { kind: "link" }>;

export const readRailPreferences = async (signal: AbortSignal, message: string) => {
  const response = await coreClient.me.rail.$get({}, { init: { signal } });
  if (!response.ok) throw new Error(message);
  return RailPreferencesSchema.parse(await response.json());
};

const saveRailPreferences = async (value: RailPreferences): Promise<RailSaveResult> => {
  const response = await coreClient.me.rail.$put({ json: value });
  if (!response.ok) return { ok: false, conflict: response.status === 409 };
  return { ok: true, settings: RailPreferencesSchema.parse(await response.json()) };
};

/**
 * One saver per page and person: changes keep saving after the editor closes, and reopening it shows what still
 * waits or failed. Another person in the same document starts with a saver of their own.
 */
let current: { userId: string | undefined; saver: RailSaver } | undefined;
let editorOpen = false;
const shellUser = () => readShellData()?.profile?.userId;
const pageSaver = () => (current && current.userId === shellUser() ? current.saver : undefined);

const railSaver = (initial: RailPreferences, locale: string) => {
  const existing = pageSaver();
  if (existing) {
    existing.refresh(initial);
    return existing;
  }
  // A save that answers after the document changed to another person reaches neither their app bar nor a toast.
  const userId = shellUser();
  const ownPage = () => shellUser() === userId;
  const saver = createRailSaver({
    initial,
    apps: () => readRailContext()?.apps ?? [],
    load: () => readRailPreferences(new AbortController().signal, railMessages.resolve([locale]).t.loadFailed),
    save: saveRailPreferences,
    saved: (settings) => {
      if (ownPage()) publishRailPreferences(settings);
    },
    failed: () => {
      if (editorOpen || !ownPage()) return;
      const t = railMessages.resolve([locale]).t;
      toast.error(t.failedClosed, { action: { label: t.open, onClick: () => openRailEditor(locale) } });
    },
  });
  current = { userId, saver };
  // The app bar shows what the editor read, also when another tab changed it since the page loaded.
  saver.refresh(initial);
  return saver;
};

const Tile = (props: { id: string; accent?: string; icon: string }) => (
  <span class="rail-editor-tile" style={appIconStyle({ id: props.id, accent: props.accent })}>
    <i class={props.icon} aria-hidden="true" />
  </span>
);

const Row = (props: {
  grip?: JSX.Element;
  tile: JSX.Element;
  title: string;
  subtitle?: string;
  off?: boolean;
  /** Set while a change to this row was not saved; it names the change for screen readers. */
  failed?: string;
  actions?: JSX.Element;
}) => (
  <div class="rail-editor-row" data-off={props.off ? "" : undefined}>
    <span class="rail-editor-row__grip">{props.grip}</span>
    {props.tile}
    <span class="rail-editor-row__text">
      <span class="rail-editor-row__title">{props.title}</span>
      <Show when={props.subtitle}>
        <span class="rail-editor-row__subtitle">{props.subtitle}</span>
      </Show>
    </span>
    <Show when={props.failed}>{(label) => <span class="rail-editor-row__failed" role="img" aria-label={label()} />}</Show>
    <span class="rail-editor-row__actions">{props.actions}</span>
  </div>
);

function LinkForm(props: { link?: LinkShortcut; submitLabel: string; onSubmit: (link: LinkShortcut) => void; onCancel: () => void }) {
  const locale = useLocale();
  const t = () => railMessages.resolve([locale()]).t;
  const [title, setTitle] = createSignal(props.link?.title ?? "");
  const [href, setHref] = createSignal(props.link?.href ?? "");
  const [icon, setIcon] = createSignal(props.link?.icon ?? "ti ti-link");
  const [checked, setChecked] = createSignal(false);
  const titleError = () => (checked() && !title().trim() ? t().titleRequired : undefined);
  const hrefError = () => (checked() && !isRailShortcutHref(href().trim()) ? t().urlInvalid : undefined);
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    setChecked(true);
    if (titleError() || hrefError()) return;
    props.onSubmit({ id: props.link?.id ?? crypto.randomUUID(), kind: "link", title: title().trim(), href: href().trim(), icon: icon() });
  };
  return (
    <form class="rail-editor-link-form" onSubmit={submit} noValidate>
      <TextInput label={t().title} value={title} maxLength={80} required error={titleError} onValueChange={setTitle} />
      <TextInput
        label={t().url}
        value={href}
        maxLength={2000}
        required
        description={t().urlHint}
        error={hrefError}
        onValueChange={setHref}
      />
      <IconInput label={t().icon} value={icon} clearable={false} onValueChange={(value) => setIcon(value ?? "ti ti-link")} />
      <div class="rail-editor-link-form__actions">
        <Button variant="ghost" size="sm" onClick={props.onCancel}>
          {t().cancel}
        </Button>
        <Button type="submit" size="sm">
          {props.submitLabel}
        </Button>
      </div>
    </form>
  );
}

function RailEditorList(props: { saver: RailSaver; apps: RailApp[] }) {
  const locale = useLocale();
  const t = () => railMessages.resolve([locale()]).t;
  const settings = () => props.saver.settings();
  const managedShortcuts = readRailContext()?.settings.managedShortcuts ?? [];
  const managed = () => projectRailNavigation(props.apps, { ...settings(), shortcuts: [], managedShortcuts }, locale()).shortcuts;
  const catalog = (appId: string) => props.apps.find((app) => app.id === appId);
  const pinned = () =>
    new Set([...managedShortcuts, ...settings().shortcuts].flatMap((entry) => (entry.kind === "app" ? [entry.appId] : [])));
  const others = () => props.apps.filter((app) => !pinned().has(app.id));
  const label = (entry: RailShortcut) => (entry.kind === "app" ? (catalog(entry.appId)?.label ?? t().unavailable) : entry.title);
  // A failed change names its row from the change itself, so the name stays when the change was taken back.
  const linkTitle = (id: string) => {
    const entry = settings().shortcuts.find((shortcut) => shortcut.id === id);
    return entry?.kind === "link" ? entry.title : undefined;
  };
  const editLabel = (edit: RailEdit): string | undefined => {
    switch (edit.kind) {
      case "visible":
      case "pin":
      case "unpin":
        return catalog(edit.appId)?.label;
      case "move":
        return "appId" in edit.target ? catalog(edit.target.appId)?.label : linkTitle(edit.target.id);
      case "addLink":
      case "updateLink":
        return edit.link.title;
      case "remove":
        return linkTitle(edit.id);
      default:
        return undefined;
    }
  };
  const editMarks = (edit: RailEdit, row: { appId?: string; id?: string }) => {
    switch (edit.kind) {
      case "visible":
      case "pin":
      case "unpin":
        return edit.appId === row.appId;
      case "move":
        return "appId" in edit.target ? edit.target.appId === row.appId : edit.target.id === row.id;
      case "addLink":
      case "updateLink":
        return edit.link.id === row.id;
      case "remove":
        return edit.id === row.id;
      default:
        return false;
    }
  };
  /** The mark on a row with a change that was not saved: its label for screen readers, or nothing. */
  const failedMark = (row: { appId?: string; id?: string }, title: string) =>
    props.saver.failures().some((edit) => editMarks(edit, row)) ? t().failedRow({ label: title }) : undefined;
  const failureText = () => {
    const failures = props.saver.failures();
    if (failures.length > 1) return t().failedMany({ count: failures.length });
    const name = failures[0] ? editLabel(failures[0]) : undefined;
    return name ? t().failedRow({ label: name }) : t().failed;
  };
  const [editing, setEditing] = createSignal<string>();
  const [adding, setAdding] = createSignal(false);
  const visible = (app: RailApp) => settings().visibility[app.id] ?? app.defaultVisible;
  const reset = () => {
    const before = settings();
    props.saver.apply({ kind: "reset" });
    toast.success(t().resetDone, {
      action: {
        label: t().undo,
        variant: "ghost",
        onClick: () => props.saver.apply({ kind: "restore", visibility: before.visibility, shortcuts: before.shortcuts }),
      },
    });
  };
  return (
    <div class="rail-editor">
      <div class="rail-editor-names">
        <Switch
          label={t().showNames}
          description={t().showNamesHint}
          value={() => settings().showNames}
          onValueChange={(showNames) => props.saver.apply({ kind: "names", showNames })}
        />
      </div>
      <Show when={props.saver.failures().length > 0}>
        <NoticeCard tone="danger" icon={true} class="rail-editor-failure">
          <span class="rail-editor-failure__text">{failureText()}</span>
          <Button variant="secondary" size="sm" onClick={props.saver.retry}>
            {t().tryAgain}
          </Button>
        </NoticeCard>
      </Show>
      <p class="rail-editor-order">{t().order}</p>
      <ul class="rail-editor-managed" aria-label={t().entries}>
        <For each={managed()}>
          {(link) => (
            <li>
              <Row
                grip={<i class="ti ti-lock rail-editor-row__lock" aria-hidden="true" />}
                tile={<Tile id={link.appId ?? link.id} accent={link.accent} icon={link.iconClass} />}
                title={link.label}
                subtitle={t().managedHint}
              />
            </li>
          )}
        </For>
      </ul>
      <SortableList
        items={settings().shortcuts}
        itemKey={(entry) => entry.id}
        itemLabel={label}
        itemIcon={(entry) => (entry.kind === "app" ? catalog(entry.appId)?.iconClass : entry.icon)}
        label={t().pinnedEntries}
        onMove={(id, index) => {
          const entry = settings().shortcuts.find((shortcut) => shortcut.id === id);
          if (entry) props.saver.apply({ kind: "move", target: entry.kind === "app" ? { appId: entry.appId } : { id }, index });
        }}
        class="rail-editor-pinned"
      >
        {(entry, handle) => {
          // An entry keeps its kind for its whole life: an app stays an app, a link a link.
          const first = entry();
          if (first.kind === "app") {
            const appId = first.appId;
            return (
              <Row
                grip={handle}
                tile={<Tile id={appId} accent={catalog(appId)?.accent} icon={catalog(appId)?.iconClass ?? "ti ti-apps"} />}
                title={label(entry())}
                failed={failedMark({ appId, id: entry().id }, label(entry()))}
                actions={
                  <>
                    <IconButton
                      class="rail-editor-pin"
                      size="sm"
                      label={t().unpin({ label: label(entry()) })}
                      aria-pressed="true"
                      onClick={() => props.saver.apply({ kind: "unpin", appId })}
                    >
                      <i class="ti ti-pinned" aria-hidden="true" />
                    </IconButton>
                    <span class="rail-editor-row__switch-slot" />
                  </>
                }
              />
            );
          }
          const link = () => {
            const current = entry();
            return current.kind === "link" ? current : first;
          };
          return (
            <>
              <Row
                grip={handle}
                tile={<Tile id={link().id} icon={link().icon} />}
                title={link().title}
                subtitle={link().href.replace(/^https?:\/\//, "")}
                failed={failedMark({ id: link().id }, link().title)}
                actions={
                  <>
                    <IconButton size="sm" label={t().editLink({ label: link().title })} onClick={() => setEditing(link().id)}>
                      <i class="ti ti-pencil" aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      size="sm"
                      label={t().removeLink({ label: link().title })}
                      onClick={() => props.saver.apply({ kind: "remove", id: link().id })}
                    >
                      <i class="ti ti-trash" aria-hidden="true" />
                    </IconButton>
                  </>
                }
              />
              <Show when={editing() === link().id}>
                <LinkForm
                  link={link()}
                  submitLabel={t().apply}
                  onCancel={() => setEditing(undefined)}
                  onSubmit={(next) => {
                    setEditing(undefined);
                    props.saver.apply({ kind: "updateLink", link: next });
                  }}
                />
              </Show>
            </>
          );
        }}
      </SortableList>
      <Show when={managed().length === 0 && settings().shortcuts.length === 0}>
        <p class="rail-editor-empty">
          <i class="ti ti-pin" aria-hidden="true" />
          <span>{t().empty}</span>
        </p>
      </Show>
      <Show
        when={adding()}
        fallback={
          <div class="rail-editor-add">
            <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
              <i class="ti ti-plus" aria-hidden="true" />
              {t().addLink}
            </Button>
          </div>
        }
      >
        <LinkForm
          submitLabel={t().add}
          onCancel={() => setAdding(false)}
          onSubmit={(link) => {
            setAdding(false);
            props.saver.apply({ kind: "addLink", link });
          }}
        />
      </Show>
      <ul class="rail-editor-apps" aria-label={t().entries}>
        <For each={others()}>
          {(app) => (
            <li>
              <Row
                tile={<Tile id={app.id} accent={app.accent} icon={app.iconClass} />}
                title={app.label}
                off={!visible(app)}
                failed={failedMark({ appId: app.id }, app.label)}
                actions={
                  <>
                    <IconButton
                      class="rail-editor-pin"
                      size="sm"
                      label={t().pin({ label: app.label })}
                      title={t().pinHint}
                      aria-pressed="false"
                      onClick={() => props.saver.apply({ kind: "pin", id: crypto.randomUUID(), appId: app.id })}
                    >
                      <i class="ti ti-pin" aria-hidden="true" />
                    </IconButton>
                    <Switch
                      aria-label={t().show({ label: app.label })}
                      value={() => visible(app)}
                      onValueChange={(next) => props.saver.apply({ kind: "visible", appId: app.id, visible: next })}
                    />
                  </>
                }
              />
            </li>
          )}
        </For>
      </ul>
      <div class="rail-editor-reset">
        <Button variant="ghost" size="sm" onClick={reset}>
          <i class="ti ti-arrow-back-up" aria-hidden="true" />
          {t().reset}
        </Button>
      </div>
    </div>
  );
}

function SaveState(props: { saver: RailSaver }) {
  const locale = useLocale();
  const t = () => railMessages.resolve([locale()]).t;
  const view = () =>
    ({
      idle: { icon: undefined, text: t().savesInstantly },
      saving: { icon: "ti ti-loader-2 animate-spin", text: t().saving },
      saved: { icon: "ti ti-check", text: t().saved },
      failed: { icon: "ti ti-alert-circle", text: t().notSaved },
    })[props.saver.busy() ? "saving" : props.saver.state()];
  return (
    <span class="rail-editor-state" data-state={props.saver.busy() ? "saving" : props.saver.state()} role="status">
      <Show when={view().icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
      {view().text}
    </span>
  );
}

function RailEditor(props: { apps: RailApp[]; close: () => void }) {
  const locale = useLocale();
  const t = () => railMessages.resolve([locale()]).t;
  // A page that still saves keeps its saver; otherwise the editor starts from the stored settings.
  const loaded = query.create({
    source: () => "rail",
    load: async (_, { abortSignal }) => {
      const waiting = pageSaver();
      return waiting?.busy() ? waiting : railSaver(await readRailPreferences(abortSignal, t().loadFailed), locale());
    },
  });
  return (
    <>
      <BottomSheet.Header title={t().customize} subtitle={t().description} icon="ti ti-layout-sidebar" close={props.close} />
      <BottomSheet.Body>
        <Show
          when={loaded.data()}
          fallback={
            <Placeholder
              state={loaded.loading() ? "loading" : "error"}
              description={loaded.loading() ? t().loading : t().loadFailed}
              action={
                <Show when={!loaded.loading() && loaded.error()}>
                  <Button size="sm" onClick={() => void loaded.refresh()}>
                    {t().retry}
                  </Button>
                </Show>
              }
            />
          }
        >
          {(current) => (
            <>
              {/* The body's first line, with a fixed height: beside the title a longer state would wrap it. */}
              <SaveState saver={current()} />
              <RailEditorList saver={current()} apps={props.apps} />
            </>
          )}
        </Show>
      </BottomSheet.Body>
    </>
  );
}

export const openRailEditor = (locale: string) => {
  const context = readRailContext();
  if (!context) return;
  editorOpen = true;
  void dialogCore
    .open<void>(
      (close, dialog) => (
        <BottomSheet onDismiss={dialog.requestDismiss} handle>
          <RailEditor apps={sortRailApps(context.apps, locale)} close={close} />
        </BottomSheet>
      ),
      { ...bottomSheetAdaptiveOptions, ariaLabel: railMessages.resolve([locale]).t.customize },
    )
    .finally(() => {
      editorOpen = false;
    });
};

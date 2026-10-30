import { files as browserFiles, images } from "@k2b/stdlib/browser";
import { Button, Dropdown, type DropdownItem, IconButton, type ToastHandle, toast } from "@k2b/ui";
import type { TextEditorController } from "@k2b/ui/text-editor";
import { createEffect, createMemo, createResource, createSignal, For, Match, on, onCleanup, Show, Switch, untrack } from "solid-js";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { api } from "../lib/api";
import { connectLive, type LiveSession } from "../lib/live";
import { type OpenNote, randomId } from "../lib/local";
import { IMAGE_MAX_SIDE, MAX_FILE_BYTES, MAX_FILES_PER_NOTE, NOTE_TEXT } from "../lib/model";
import { preferences } from "../prefs";
import { navigate } from "../router";
import { app, t } from "../state";
import { Accessory } from "../ui/Accessory";
import { Footer, Icon, type IconName, Wordmark } from "../ui/common";
import { NoteEditor } from "../ui/Editor";
import { openDelete } from "./Delete";
import { EXAMPLE_TEXT } from "./example";
import { overviewMenu } from "./menus";
import { openPalette } from "./Palette";
import { openReport } from "./Report";
import { openSettings } from "./Settings";
import { openShare, stopSharing } from "./Share";

type Status = "local" | "shared" | "syncing" | "offline" | "read" | "example" | "unsaved" | "pendingDelete";

/** A draft opened on the first visit hands its text over to the store on the first keystroke. */
let focusNext: string | null = null;
/** True from the first keystroke of the draft until its note is open, so the overview does not replace it early. */
const [handingOff, setHandingOff] = createSignal(false);

export { handingOff };

const STATUSES: Status[] = ["local", "shared", "syncing", "offline", "read", "example", "unsaved", "pendingDelete"];

/** Every label sits in the same grid cell, so the status always takes the width of its longest wording. */
function StatusLabel(props: { status: Status }) {
  const views = (): Record<Status, [IconName, string, string, string | undefined]> => {
    const m = t();
    return {
      local: ["ti-device-desktop", m.statusLocal, m.statusLocalShort, undefined],
      shared: ["ti-circle-check", m.statusShared, m.statusSharedShort, "ok"],
      syncing: ["ti-loader-2", m.statusSyncing, m.statusSyncingShort, undefined],
      offline: ["ti-cloud-off", m.statusOffline, m.statusOfflineShort, undefined],
      read: ["ti-eye", m.statusRead, m.statusReadShort, undefined],
      example: ["ti-sparkles", m.statusExample, m.statusExampleShort, undefined],
      unsaved: ["ti-alert-triangle", m.statusUnsaved, m.statusUnsavedShort, "danger"],
      pendingDelete: ["ti-trash", m.statusPendingDelete, m.statusPendingDeleteShort, "warn"],
    };
  };
  const view = () => views()[props.status];
  return (
    <span class="n-status" role="status" data-tone={view()[3]}>
      <Icon name={view()[0]} class={props.status === "syncing" ? "n-spin" : undefined} />
      <span class="n-labels n-long">
        <For each={STATUSES}>{(status) => <span data-active={status === props.status ? "" : undefined}>{views()[status][1]}</span>}</For>
      </span>
      <span class="n-labels n-short">
        <For each={STATUSES}>{(status) => <span data-active={status === props.status ? "" : undefined}>{views()[status][2]}</span>}</For>
      </span>
    </span>
  );
}

function Faces(props: { people: { name: string; color: string }[] }) {
  const names = () => props.people.map((person) => person.name).join(", ");
  return (
    <Show when={props.people.length > 0}>
      <span class="n-faces" title={t().hereNow({ names: names(), count: props.people.length })}>
        <For each={props.people.slice(0, 5)}>
          {(person) => (
            <span class="n-face" style={{ "--c": person.color }} aria-hidden="true">
              {Array.from(person.name)[0]?.toUpperCase()}
            </span>
          )}
        </For>
      </span>
      <span class="n-faces-text">
        {props.people.length > 1
          ? t().writeAlongMany({ count: props.people.length })
          : t().writesAlong({ name: props.people[0]?.name ?? "" })}
      </span>
      <span class="n-sr">{t().hereNow({ names: names(), count: props.people.length })}</span>
    </Show>
  );
}

export type NoteMode = { kind: "local"; id: string } | { kind: "draft" } | { kind: "example" };

export function NotePage(props: { mode: NoteMode }) {
  const toasts = new Set<ToastHandle>();
  const notice = (handle: ToastHandle) => {
    toasts.add(handle);
    return handle;
  };
  onCleanup(() => {
    for (const handle of toasts) handle.dismiss();
  });

  const record = createMemo(() => {
    const mode = props.mode;
    return mode.kind === "local" ? app.records().find((entry) => entry.id === mode.id) : undefined;
  });
  const [editor, setEditor] = createSignal<TextEditorController>();
  const [undo, setUndo] = createSignal<() => void>(() => {});

  // The open document: from the store for local notes, in memory for the draft and the example.
  const [opened] = createResource(
    () => (app.ready() ? props.mode : undefined),
    async (mode): Promise<OpenNote | { doc: Y.Doc; text: Y.Text; close: () => Promise<void>; id: null }> => {
      if (mode.kind === "local") return (await app.store()?.open(mode.id)) ?? Promise.reject(new Error("store"));
      const doc = new Y.Doc();
      const text = doc.getText(NOTE_TEXT);
      if (mode.kind === "example") text.insert(0, EXAMPLE_TEXT[preferences.locale()]);
      return { id: null, doc, text, close: async () => doc.destroy() };
    },
  );
  onCleanup(() => void opened()?.close());

  const awareness = createMemo(() => {
    const current = opened();
    if (!current) return undefined;
    const value = new Awareness(current.doc);
    value.setLocalStateField("user", { name: preferences.name(), color: "#6d28d9" });
    onCleanup(() => value.destroy());
    return value;
  });
  createEffect(() => awareness()?.setLocalStateField("user", { name: preferences.name(), color: "#6d28d9" }));

  // Unknown local id: back to the overview instead of an empty editor.
  createEffect(() => {
    if (props.mode.kind === "local" && app.ready() && !record() && opened.state !== "pending") navigate("/", { replace: true });
  });

  // Draft → note on the first local change, then continue on /n/:id with the caret where it was.
  createEffect(() => {
    const current = opened();
    if (props.mode.kind !== "draft" || !current) return;
    const store = app.store();
    if (!store) return;
    let handing = false;
    const handoff = async () => {
      if (handing) return;
      handing = true;
      setHandingOff(true);
      const id = randomId();
      // Every later keystroke queues behind the note's creation, so nothing typed during the switch is lost.
      let written = store.create("", { id }).then(() => store.applyUpdate(id, Y.encodeStateAsUpdate(current.doc)));
      current.doc.on("update", (update: Uint8Array) => {
        written = written.then(() => store.applyUpdate(id, update));
      });
      try {
        await written;
        focusNext = id;
        navigate(`/n/${id}`, { replace: true });
      } finally {
        setHandingOff(false);
      }
    };
    current.doc.on("update", () => void handoff());
  });

  // Live connection for shared notes.
  const [live, setLive] = createSignal<LiveSession>();
  // Keyed by the link, not the record object: every index write (openedAt, meta) creates a new record.
  const shareKey = createMemo(() => {
    const share = record()?.share;
    if (!share) return null;
    return share.kind === "own" ? `own:${share.editId}` : `foreign:${share.role}:${share.linkId}`;
  });
  createEffect(
    on(
      () => [opened(), awareness(), shareKey()] as const,
      ([current, aw, key]) => {
        const share = untrack(() => record()?.share);
        if (!current || !aw || !key || !share) return;
        const linkId = share.kind === "own" ? share.editId : share.linkId;
        const canEdit = share.kind === "own" || share.role === "edit";
        const session = connectLive({
          linkId,
          doc: current.doc,
          awareness: aw,
          canEdit,
          onMerged: (report) => {
            const names = session.people().filter((person) => person.writerId !== null && report.writers.includes(person.writerId));
            notice(
              toast.success(t().mergedBody({ count: report.remoteChanges, names: names.map((person) => person.name).join(", ") }), {
                title: t().mergedTitle,
                iconClass: "ti ti-arrows-join",
              }),
            );
          },
          // A deletion started here also closes the socket; only someone else's deletion explains itself on /p/….
          onGone: () => {
            if (!untrack(record)?.pendingDelete) navigate(`/p/${linkId}`, { replace: true });
          },
        });
        setLive(session);
        void api.opened(linkId).catch(() => {});
        onCleanup(() => {
          session.close();
          setLive(undefined);
        });
      },
    ),
  );

  const status = createMemo<Status>(() => {
    if (props.mode.kind === "example") return "example";
    const current = record();
    if (current?.pendingDelete) return "pendingDelete";
    if (app.storeError() === "quota") return "unsaved";
    const session = live();
    if (!current?.share) return "local";
    if (!session) return "syncing";
    const state = session.status();
    if (state === "offline") return "offline";
    if (state === "unsaved" || state === "full") return "unsaved";
    if (state === "connecting") return "syncing";
    return current.share.kind === "foreign" && current.share.role === "read" ? "read" : "shared";
  });
  const foreignLink = () => {
    const share = record()?.share;
    return share?.kind === "foreign" ? share.linkId : undefined;
  };
  const readOnly = () => {
    const share = record()?.share;
    return share?.kind === "foreign" && share.role === "read";
  };
  // Memos, so a keystroke that renews the record does not reset the editor's label mid-update.
  const editorLabel = createMemo(() => record()?.meta.title || t().newNoteLabel);
  const editorReadOnly = createMemo(() => readOnly() || record()?.pendingDelete === true);

  // Floating notes for state changes.
  let offlineToast: ToastHandle | undefined;
  createEffect(
    on(status, (next) => {
      if (next === "offline" && !offlineToast)
        offlineToast = notice(toast(t().offlineBody, { title: t().offlineTitle, duration: 0, iconClass: "ti ti-cloud-off" }));
      if (next !== "offline" && offlineToast) {
        offlineToast.dismiss();
        offlineToast = undefined;
      }
    }),
  );
  createEffect(
    on(
      () => live()?.status(),
      (state) => {
        if (state === "unsaved")
          notice(
            toast.error(t().unsavedBody, {
              title: t().unsavedTitle,
              duration: 0,
              action: { label: t().keepCopy, onClick: () => void keepCopy() },
            }),
          );
        if (state === "full") notice(toast.error(t().noteFullBody, { title: t().noteFullTitle, duration: 0 }));
      },
    ),
  );
  createEffect(() => {
    const share = record()?.share;
    if (share?.kind !== "foreign" || share.role !== "edit" || preferences.guestNameSeen()) return;
    preferences.markGuestNameSeen();
    const others = live()?.people() ?? [];
    notice(
      toast(t().guestBody({ names: others.map((person) => person.name).join(", ") }), {
        title: t().guestTitle({ name: preferences.name() }),
        duration: 0,
        iconClass: "ti ti-user",
        action: { label: t().changeName, onClick: () => openSettings() },
      }),
    );
  });

  // A memo compares by value, so writing openedAt (which renews the record) does not run this again.
  const recordId = createMemo(() => record()?.id);
  createEffect(
    on(recordId, (id) => {
      if (id) void app.store()?.update(id, { openedAt: Date.now() });
    }),
  );

  // Files of this note as object URLs, so images show offline; a shared note falls back to the server copy.
  const [files, setFiles] = createSignal<Record<string, string>>({});
  const showFile = (key: string, blob: Blob) => setFiles((current) => ({ ...current, [key]: URL.createObjectURL(blob) }));
  createEffect(
    on(recordId, (id) => {
      let active = true;
      onCleanup(() => {
        active = false;
        for (const url of Object.values(untrack(files))) URL.revokeObjectURL(url);
        setFiles({});
      });
      if (id)
        void app
          .store()
          ?.listFiles(id)
          .then((list) => {
            if (active) for (const file of list) showFile(file.key, file.blob);
          });
    }),
  );
  // A string, so writing the record on every keystroke does not reconfigure the editor in the middle of its update.
  const remoteReadId = createMemo(() => record()?.share?.readId);

  const keepCopy = async () => {
    const current = opened();
    if (!current) return;
    await app.createNote(current.text.toString());
  };

  const addFiles = async (list: File[]) => {
    const store = app.store();
    const current = record();
    const view = editor()?.view;
    if (!store || !current || !view) return;
    const existing = (await store.listFiles(current.id)).length;
    let room = MAX_FILES_PER_NOTE - existing;
    for (const original of list) {
      if (room <= 0) {
        notice(toast.error(t().tooManyFiles));
        return;
      }
      const isImage = original.type.startsWith("image/") && original.type !== "image/svg+xml";
      if (!isImage && original.type !== "application/pdf") {
        notice(toast.error(t().wrongTypeBody, { title: t().wrongTypeTitle({ name: original.name }), iconClass: "ti ti-file-alert" }));
        continue;
      }
      let file: Blob = original;
      if (isImage) {
        const progress = notice(toast(t().imageResizing, { duration: 0, progress: "indeterminate", iconClass: "ti ti-photo" }));
        try {
          const data = await images.create(original);
          const wide = data.width >= data.height;
          if (Math.max(data.width, data.height) > IMAGE_MAX_SIDE)
            file = await images
              .resize(
                wide ? IMAGE_MAX_SIDE : undefined,
                wide ? undefined : IMAGE_MAX_SIDE,
              )(data)
              .then(images.toBlob("webp", 0.85));
        } catch {
          file = original;
        } finally {
          progress.dismiss();
        }
      }
      if (file.size > MAX_FILE_BYTES) {
        notice(toast.error(t().tooBigBody, { title: t().tooBigTitle({ name: original.name }), iconClass: "ti ti-file-alert" }));
        continue;
      }
      const key = await store.putFile(current.id, file, original.name);
      showFile(key, file);
      room -= 1;
      const share = current.share;
      const editId = share?.kind === "own" ? share.editId : share?.kind === "foreign" && share.role === "edit" ? share.linkId : null;
      if (editId) void api.uploadFile(editId, file, key).catch(() => notice(toast.error(t().uploadFailed)));
      const alt = original.name.replace(/\.[^.]+$/, "").replace(/[[\]]/g, "");
      const insert = isImage ? `\n![${alt}](file:${key})\n` : `\n[${original.name.replace(/[[\]]/g, "")}](file:${key})\n`;
      const at = view.state.selection.main.head;
      view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length } });
    }
  };

  const downloadMarkdown = () => {
    const current = opened();
    if (!current) return;
    const title = record()?.meta.title || t().untitled;
    browserFiles.downloadFileFromContent(
      current.text.toString(),
      `${title.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80) || "notiz"}.md`,
      "text/markdown",
    );
  };
  const addTag = () => {
    const view = editor()?.view;
    if (!view) return;
    const line = view.state.doc.line(Math.min(2, view.state.doc.lines));
    const insert = line.number === 1 ? "\n#" : `${line.text.trim() ? " " : ""}#`;
    const at = line.to;
    view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length } });
    view.focus();
  };

  const menu = (): DropdownItem[] => {
    const current = record();
    if (props.mode.kind !== "local" || !current) return overviewMenu();
    const own = current.share?.kind !== "foreign";
    const items: DropdownItem[] = [
      {
        items: [
          ...(readOnly() ? [] : [{ label: t().addTag, icon: "ti ti-hash", action: addTag }]),
          { label: t().downloadMarkdown, icon: "ti ti-markdown", action: downloadMarkdown },
          ...(current.share?.kind === "own"
            ? [{ label: t().stopSharing, icon: "ti ti-link-off", action: () => void stopSharing(current) }]
            : []),
          ...(!own
            ? [
                {
                  label: t().removeFromList,
                  icon: "ti ti-eye-off",
                  action: async () => {
                    await app.store()?.remove(current.id);
                    navigate("/", { replace: true });
                  },
                },
                {
                  label: t().reportContent,
                  icon: "ti ti-flag",
                  action: () => openReport(foreignLink()),
                },
              ]
            : []),
        ],
      },
    ];
    if (own)
      items.push({ items: [{ label: t().deleteNote, icon: "ti ti-trash", variant: "danger", action: () => void openDelete(current) }] });
    return items;
  };

  const shareButton = () => {
    if (props.mode.kind === "example")
      return (
        <Button variant="primary" onClick={() => void app.createNote()}>
          <Icon name="ti-plus" />
          <span class="n-share-lbl">{t().startOwnNote}</span>
        </Button>
      );
    if (readOnly())
      return (
        <Button variant="secondary" onClick={() => void keepCopy()}>
          <Icon name="ti-copy" />
          <span class="n-share-lbl">{t().editAsCopy}</span>
        </Button>
      );
    const current = record();
    const offline = !app.online();
    return (
      <Button
        variant={current?.share ? "secondary" : "primary"}
        disabled={offline || !current || current.pendingDelete}
        tooltip={offline ? t().shareOffline : false}
        aria-label={t().share}
        onClick={() => current && openShare(current.id)}
      >
        <Icon name="ti-share-2" />
        <span class="n-share-lbl">{t().share}</span>
      </Button>
    );
  };

  const first = () => props.mode.kind === "draft";

  return (
    <div class="n-page">
      <header class="n-topbar">
        <Switch>
          <Match when={first()}>
            <Wordmark />
          </Match>
          <Match when={!first()}>
            <a class="n-back" href="/" aria-label={t().back}>
              <Icon name="ti-arrow-left" />
              <span class="n-lbl">{t().back}</span>
            </a>
            <StatusLabel status={status()} />
          </Match>
        </Switch>
        <div class="n-spacer" />
        <Show when={!first()}>
          <Faces people={live()?.people() ?? []} />
          <IconButton variant="ghost" label={t().searchEverywhere} onClick={() => openPalette()}>
            <Icon name="ti-search" />
          </IconButton>
          {shareButton()}
        </Show>
        <Dropdown.Root items={menu()} align="end" phone="sheet">
          <Dropdown.Trigger iconOnly label={t().moreActions} variant="ghost">
            <Icon name="ti-dots" />
          </Dropdown.Trigger>
        </Dropdown.Root>
      </header>
      <main class="n-doc" data-first={first() ? "" : undefined}>
        <Show
          when={(() => {
            const current = opened();
            const aw = awareness();
            return current && aw ? { text: current.text, awareness: aw } : undefined;
          })()}
          fallback={<div class="n-editor" aria-busy="true" />}
        >
          {(ready) => (
            <NoteEditor
              text={ready().text}
              awareness={ready().awareness}
              label={editorLabel()}
              readOnly={editorReadOnly()}
              placeholder={first() ? t().titlePlaceholder : undefined}
              autofocus={first() ? "start" : focusNext === record()?.id ? "end" : undefined}
              onReady={(value, undoLast) => {
                setEditor(value);
                setUndo(() => undoLast);
                if (focusNext === record()?.id) focusNext = null;
              }}
              onFiles={(list) => void addFiles(list)}
              files={files()}
              remoteReadId={remoteReadId()}
            />
          )}
        </Show>
        <Show when={first()}>
          <p class="n-first-body n-ph">{t().bodyPlaceholder}</p>
          <div class="n-md-hint n-ph">
            <code># {t().titlePlaceholder}</code>
            <span>{t().hintHeading}</span>
            <code>**{t().hintBold}**</code>
            <span>{t().hintBold}</span>
            <code>- [ ] …</code>
            <span>{t().hintTask}</span>
            <code>#idee</code>
            <span>{t().hintTag}</span>
          </div>
          <div class="n-example-link">
            <a href="/beispiel">
              <Icon name="ti-sparkles" />
              {t().showExample}
            </a>
            <span>{t().showExampleHint}</span>
          </div>
          <div class="n-facts">
            <span>
              <Icon name="ti-device-desktop" />
              {t().factBrowser}
            </span>
            <span>
              <Icon name="ti-user-off" />
              {t().factNoAccount}
            </span>
            <span>
              <Icon name="ti-link" />
              {t().factShare}
            </span>
          </div>
        </Show>
      </main>
      <Show when={!readOnly() && props.mode.kind !== "draft" ? editor() : undefined}>
        {(current) => <Accessory editor={current()} onUndo={() => undo()()} onFiles={(list) => void addFiles(list)} />}
      </Show>
      <Footer narrow onReport={() => openReport(foreignLink())} />
    </div>
  );
}

import { createSignal } from "solid-js";
import type { RailPreferences, RailShortcut } from "../contracts/rail-preferences";
import type { RailApp } from "./rail-navigation";

type LinkShortcut = Extract<RailShortcut, { kind: "link" }>;

/**
 * One change in the app bar editor, stated as the result it wants rather than a toggle, so applying it twice, or
 * again on a newer state after a conflict, gives the same settings.
 */
export type RailEdit =
  | { kind: "names"; showNames: boolean }
  | { kind: "visible"; appId: string; visible: boolean }
  | { kind: "pin"; id: string; appId: string }
  | { kind: "unpin"; appId: string }
  | { kind: "move"; id: string; index: number }
  | { kind: "addLink"; link: LinkShortcut }
  | { kind: "updateLink"; link: LinkShortcut }
  | { kind: "remove"; id: string }
  | { kind: "reset" }
  | { kind: "restore"; visibility: RailPreferences["visibility"]; shortcuts: RailShortcut[] };

const setVisibility = (settings: RailPreferences, app: RailApp | undefined, appId: string, visible: boolean) => {
  const visibility = { ...settings.visibility };
  if (app && visible === app.defaultVisible) delete visibility[appId];
  else visibility[appId] = visible;
  return visibility;
};

export const applyRailEdit = (settings: RailPreferences, edit: RailEdit, apps: readonly RailApp[]): RailPreferences => {
  const app = (appId: string) => apps.find((entry) => entry.id === appId);
  switch (edit.kind) {
    case "names":
      return { ...settings, showNames: edit.showNames };
    case "visible":
      return { ...settings, visibility: setVisibility(settings, app(edit.appId), edit.appId, edit.visible) };
    case "pin":
      // A pinned app is shown; unpinning it later leaves it shown among the other apps.
      if (settings.shortcuts.some((entry) => entry.kind === "app" && entry.appId === edit.appId)) return settings;
      return {
        ...settings,
        visibility: setVisibility(settings, app(edit.appId), edit.appId, true),
        shortcuts: [...settings.shortcuts, { id: edit.id, kind: "app", appId: edit.appId }],
      };
    case "unpin":
      return { ...settings, shortcuts: settings.shortcuts.filter((entry) => !(entry.kind === "app" && entry.appId === edit.appId)) };
    case "move": {
      const from = settings.shortcuts.findIndex((entry) => entry.id === edit.id);
      if (from < 0) return settings;
      const shortcuts = [...settings.shortcuts];
      const [entry] = shortcuts.splice(from, 1);
      shortcuts.splice(Math.max(0, Math.min(shortcuts.length, edit.index)), 0, entry!);
      return { ...settings, shortcuts };
    }
    case "addLink":
      if (settings.shortcuts.some((entry) => entry.id === edit.link.id)) return settings;
      return { ...settings, shortcuts: [...settings.shortcuts, edit.link] };
    case "updateLink":
      return { ...settings, shortcuts: settings.shortcuts.map((entry) => (entry.id === edit.link.id ? edit.link : entry)) };
    case "remove":
      return { ...settings, shortcuts: settings.shortcuts.filter((entry) => entry.id !== edit.id) };
    case "reset":
      return { ...settings, visibility: {}, shortcuts: [] };
    case "restore":
      return { ...settings, visibility: edit.visibility, shortcuts: edit.shortcuts };
  }
};

/** The row a change belongs to, for the mark on a step that was not saved. */
export const railEditRow = (edit: RailEdit): string | undefined => {
  switch (edit.kind) {
    case "visible":
    case "pin":
    case "unpin":
      return edit.appId;
    case "move":
    case "remove":
      return edit.id;
    case "addLink":
    case "updateLink":
      return edit.link.id;
    default:
      return undefined;
  }
};

const sameSettings = (a: RailPreferences, b: RailPreferences) =>
  a.showNames === b.showNames &&
  JSON.stringify(a.shortcuts) === JSON.stringify(b.shortcuts) &&
  JSON.stringify(Object.entries(a.visibility).sort()) === JSON.stringify(Object.entries(b.visibility).sort());

export type RailSaveResult = { ok: true; settings: RailPreferences } | { ok: false; conflict: boolean };
export type RailSaveState = "idle" | "saving" | "saved" | "failed";

/**
 * Saves each change on its own, one after another. The editor shows the saved settings with every waiting change
 * applied. A change meets a newer state once (another tab saved): it reloads and applies again. Any other failure
 * drops only that change, keeps it for "Try again", and lets the waiting ones continue.
 */
export const createRailSaver = (options: {
  initial: RailPreferences;
  apps: () => readonly RailApp[];
  load: () => Promise<RailPreferences>;
  save: (settings: RailPreferences) => Promise<RailSaveResult>;
  /** The saved settings after each successful step, for the app bar. */
  saved: (settings: RailPreferences) => void;
  /** A step failed; the editor may be closed by then. */
  failed?: (edit: RailEdit) => void;
}) => {
  const [confirmed, setConfirmed] = createSignal(options.initial);
  const [queue, setQueue] = createSignal<readonly RailEdit[]>([]);
  const [failure, setFailure] = createSignal<RailEdit | undefined>();
  const [state, setState] = createSignal<RailSaveState>("idle");
  let running = false;

  const step = async (edit: RailEdit) => {
    let base = confirmed();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const next = applyRailEdit(base, edit, options.apps());
      if (sameSettings(next, base)) return true;
      const result = await options.save(next);
      if (result.ok) {
        setConfirmed(result.settings);
        options.saved(result.settings);
        return true;
      }
      if (!result.conflict || attempt > 0) return false;
      base = await options.load();
      setConfirmed(base);
      options.saved(base);
    }
    return false;
  };

  const drain = async () => {
    if (running) return;
    running = true;
    setState("saving");
    let ok = true;
    while (queue().length) {
      const edit = queue()[0]!;
      const saved = await step(edit).catch(() => false);
      setQueue((items) => items.slice(1));
      if (!saved) {
        ok = false;
        setFailure(edit);
        options.failed?.(edit);
      }
    }
    running = false;
    setState(ok && !failure() ? "saved" : "failed");
  };

  return {
    /** What the editor shows: the saved settings with every waiting change applied. */
    settings: () => queue().reduce((settings, edit) => applyRailEdit(settings, edit, options.apps()), confirmed()),
    state,
    failure,
    busy: () => queue().length > 0,
    apply: (edit: RailEdit) => {
      setQueue((items) => [...items, edit]);
      void drain();
    },
    retry: () => {
      const edit = failure();
      if (!edit) return;
      setFailure(undefined);
      setQueue((items) => [...items, edit]);
      void drain();
    },
    dismissFailure: () => {
      setFailure(undefined);
      if (!queue().length) setState("idle");
    },
    /** Replaces the saved settings when nothing waits, as after reopening the editor. */
    refresh: (settings: RailPreferences) => {
      if (!queue().length) setConfirmed(settings);
    },
  };
};
export type RailSaver = ReturnType<typeof createRailSaver>;

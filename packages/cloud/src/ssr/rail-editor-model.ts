import { createSignal } from "solid-js";
import type { RailPreferences, RailShortcut } from "../contracts/rail-preferences";
import type { RailApp } from "./rail-navigation";

type LinkShortcut = Extract<RailShortcut, { kind: "link" }>;

/**
 * One change in the app bar editor, stated as the result it wants rather than a toggle, so applying it twice, or
 * again on a newer state after a conflict, gives the same settings. A pinned app is named by its app, never by its
 * shortcut ID, which another tab may have chosen differently.
 */
export type RailEdit =
  | { kind: "names"; showNames: boolean }
  | { kind: "visible"; appId: string; visible: boolean }
  | { kind: "pin"; id: string; appId: string }
  | { kind: "unpin"; appId: string }
  | { kind: "move"; target: { appId: string } | { id: string }; index: number }
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

/** Whether a shortcut is the one a move or a failure mark means. */
export const railEditTargets = (entry: RailShortcut, target: { appId: string } | { id: string }) =>
  "appId" in target ? entry.kind === "app" && entry.appId === target.appId : entry.id === target.id;

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
      const from = settings.shortcuts.findIndex((entry) => railEditTargets(entry, edit.target));
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

const sameSettings = (a: RailPreferences, b: RailPreferences) =>
  a.showNames === b.showNames &&
  JSON.stringify(a.shortcuts) === JSON.stringify(b.shortcuts) &&
  JSON.stringify(Object.entries(a.visibility).sort()) === JSON.stringify(Object.entries(b.visibility).sort());

export type RailSaveResult = { ok: true; settings: RailPreferences } | { ok: false; conflict: boolean };
export type RailSaveState = "idle" | "saving" | "saved" | "failed";

/**
 * Saves each change on its own, one after another. The editor shows the saved settings with every waiting change
 * applied. A change meets a newer state once (another tab saved): it reloads and applies again. Any other failure
 * takes back only that change and keeps it for "Try again"; the waiting ones continue. After a failure the next
 * change starts from a fresh read, since the failed write may have reached the server.
 */
export const createRailSaver = (options: {
  initial: RailPreferences;
  apps: () => readonly RailApp[];
  load: () => Promise<RailPreferences>;
  save: (settings: RailPreferences) => Promise<RailSaveResult>;
  /** The saved settings after each change on the server, for the app bar. */
  saved: (settings: RailPreferences) => void;
  /** A step failed; the editor may be closed by then. */
  failed?: (edit: RailEdit) => void;
}) => {
  const [confirmed, setConfirmed] = createSignal(options.initial);
  const [queue, setQueue] = createSignal<readonly RailEdit[]>([]);
  const [failures, setFailures] = createSignal<readonly RailEdit[]>([]);
  const [settled, setSettled] = createSignal(false);
  let running = false;
  let stale = false;

  /**
   * A failed change that the saved settings already contain needs no retry and no mark. A move whose entry is not
   * there (its pin failed too) is not done: it stays for "Try again", after that pin.
   */
  const satisfied = (settings: RailPreferences, edit: RailEdit) => {
    if (edit.kind === "move" && !settings.shortcuts.some((entry) => railEditTargets(entry, edit.target))) return false;
    return sameSettings(applyRailEdit(settings, edit, options.apps()), settings);
  };
  const adopt = (settings: RailPreferences) => {
    setConfirmed(settings);
    options.saved(settings);
    setFailures((items) => items.filter((edit) => !satisfied(settings, edit)));
  };

  /** A move of an entry whose pin or link failed waits with it, instead of passing as a change with no effect. */
  const waitsForFailure = (edit: RailEdit) =>
    edit.kind === "move" &&
    !confirmed().shortcuts.some((entry) => railEditTargets(entry, edit.target)) &&
    failures().some((failed) =>
      "appId" in edit.target
        ? failed.kind === "pin" && failed.appId === edit.target.appId
        : failed.kind === "addLink" && failed.link.id === edit.target.id,
    );

  const step = async (edit: RailEdit) => {
    if (stale) {
      adopt(await options.load());
      stale = false;
    }
    if (waitsForFailure(edit)) return false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const base = confirmed();
      const next = applyRailEdit(base, edit, options.apps());
      if (sameSettings(next, base)) return true;
      const result = await options.save(next);
      if (result.ok) {
        adopt(result.settings);
        return true;
      }
      if (!result.conflict || attempt > 0) return false;
      adopt(await options.load());
    }
    return false;
  };

  const drain = async () => {
    if (running) return;
    running = true;
    while (queue().length) {
      const edit = queue()[0]!;
      const saved = await step(edit).catch(() => false);
      setQueue((items) => items.slice(1));
      if (!saved) {
        stale = true;
        setFailures((items) => [...items, edit]);
        options.failed?.(edit);
      }
    }
    running = false;
    setSettled(true);
  };

  const apply = (edit: RailEdit) => {
    setQueue((items) => [...items, edit]);
    void drain();
  };

  return {
    /** What the editor shows: the saved settings with every waiting change applied. */
    settings: () => queue().reduce((settings, edit) => applyRailEdit(settings, edit, options.apps()), confirmed()),
    /** Saving while changes wait; failed while any change waits for "Try again"; saved once anything finished. */
    state: (): RailSaveState => (queue().length ? "saving" : failures().length ? "failed" : settled() ? "saved" : "idle"),
    failures,
    busy: () => queue().length > 0,
    apply,
    /** Saves every failed change again, in the order it was made. */
    retry: () => {
      const edits = failures();
      setFailures([]);
      for (const edit of edits) apply(edit);
    },
    /**
     * Takes stored settings read when the editor opened, when nothing waits and they are not older than what this
     * saver already saved, and shows them in the app bar.
     */
    refresh: (settings: RailPreferences) => {
      if (!queue().length && settings.revision >= confirmed().revision) adopt(settings);
    },
  };
};
export type RailSaver = ReturnType<typeof createRailSaver>;

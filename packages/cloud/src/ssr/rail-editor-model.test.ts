import { expect, test } from "bun:test";
import { defaultRailPreferences, type RailPreferences } from "../contracts/rail-preferences";
import { applyRailEdit, createRailSaver, type RailEdit, type RailSaveResult } from "./rail-editor-model";
import type { RailApp } from "./rail-navigation";

const app = (id: string, defaultVisible = true): RailApp => ({
  id,
  label: id,
  href: `/app/${id}`,
  match: `/app/${id}`,
  iconClass: "ti ti-box",
  defaultVisible,
});
const apps = [app("mail"), app("chat"), app("spaces", false)];
const base = (): RailPreferences => ({ ...defaultRailPreferences(), revision: 1 });
const link = { id: "l1", kind: "link" as const, title: "Intranet", href: "https://intranet.example", icon: "ti ti-world" };

test("every change states its result, so applying it twice or on a newer state changes nothing more", () => {
  const edits: RailEdit[] = [
    { kind: "names", showNames: false },
    { kind: "visible", appId: "mail", visible: false },
    { kind: "visible", appId: "spaces", visible: true },
    { kind: "pin", id: "p1", appId: "chat" },
    { kind: "addLink", link },
    { kind: "move", id: "l1", index: 0 },
    { kind: "updateLink", link: { ...link, title: "Wiki" } },
  ];
  let settings = base();
  for (const edit of edits) {
    const once = applyRailEdit(settings, edit, apps);
    expect(applyRailEdit(once, edit, apps)).toEqual(once);
    settings = once;
  }
  expect(settings).toEqual({
    ...base(),
    showNames: false,
    visibility: { mail: false, spaces: true },
    shortcuts: [
      { ...link, title: "Wiki" },
      { id: "p1", kind: "app", appId: "chat" },
    ],
  });
  // A pin shows the app; a visible default app leaves no entry behind.
  expect(applyRailEdit({ ...base(), visibility: { mail: false } }, { kind: "pin", id: "p2", appId: "mail" }, apps).visibility).toEqual({});
  expect(applyRailEdit(settings, { kind: "unpin", appId: "chat" }, apps).shortcuts).toEqual([{ ...link, title: "Wiki" }]);
  expect(applyRailEdit(settings, { kind: "remove", id: "l1" }, apps).shortcuts).toEqual([{ id: "p1", kind: "app", appId: "chat" }]);
  const reset = applyRailEdit(settings, { kind: "reset" }, apps);
  expect(reset).toEqual({ ...base(), showNames: false });
  expect(applyRailEdit(reset, { kind: "restore", visibility: settings.visibility, shortcuts: settings.shortcuts }, apps)).toEqual(settings);
});

/** A Core stand-in: revisioned writes, answers released one by one by the test. */
const server = (initial: RailPreferences) => {
  let stored = initial;
  const writes: RailPreferences[] = [];
  const pending: (() => void)[] = [];
  let failNext = 0;
  const save = (value: RailPreferences) =>
    new Promise<RailSaveResult>((resolve) => {
      writes.push(value);
      pending.push(() => {
        if (failNext > 0) {
          failNext -= 1;
          return resolve({ ok: false, conflict: false });
        }
        if (value.revision !== stored.revision) return resolve({ ok: false, conflict: true });
        stored = { ...value, revision: stored.revision + 1 };
        resolve({ ok: true, settings: stored });
      });
    });
  return {
    writes,
    stored: () => stored,
    save,
    load: async () => stored,
    /** Another tab saves in between. */
    external: (value: Partial<RailPreferences>) => {
      stored = { ...stored, ...value, revision: stored.revision + 1 };
    },
    failNext: () => {
      failNext += 1;
    },
    release: async () => {
      for (let turn = 0; turn < 20 && !pending.length; turn += 1) await Promise.resolve();
      pending.shift()?.();
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    },
  };
};

test("changes save one after another, each on the result of the one before", async () => {
  const core = server(base());
  const published: number[] = [];
  const saver = createRailSaver({
    initial: base(),
    apps: () => apps,
    load: core.load,
    save: core.save,
    saved: (s) => published.push(s.revision),
  });
  saver.apply({ kind: "pin", id: "p1", appId: "chat" });
  saver.apply({ kind: "visible", appId: "mail", visible: false });
  // The editor shows both at once, while only the first is on its way.
  expect(saver.settings().shortcuts).toHaveLength(1);
  expect(saver.settings().visibility).toEqual({ mail: false });
  expect(saver.busy()).toBe(true);
  await core.release();
  await core.release();
  expect(core.writes.map((write) => write.revision)).toEqual([1, 2]);
  expect(core.writes[1]?.shortcuts).toHaveLength(1);
  expect(core.stored()).toMatchObject({ revision: 3, visibility: { mail: false } });
  expect(published).toEqual([2, 3]);
  expect([saver.busy(), saver.state(), saver.failure()]).toEqual([false, "saved", undefined]);
});

test("a change that meets a newer state reloads and applies once more, keeping the other tab's work", async () => {
  const core = server(base());
  const saver = createRailSaver({ initial: base(), apps: () => apps, load: core.load, save: core.save, saved: () => {} });
  core.external({ visibility: { spaces: true } });
  saver.apply({ kind: "pin", id: "p1", appId: "chat" });
  await core.release();
  await core.release();
  expect(core.stored()).toMatchObject({ visibility: { spaces: true }, shortcuts: [{ appId: "chat" }] });
  expect(saver.failure()).toBeUndefined();
});

test("a failed change alone goes back, the next ones still save, and Try again saves it later", async () => {
  const core = server(base());
  const failed: RailEdit[] = [];
  const saver = createRailSaver({
    initial: base(),
    apps: () => apps,
    load: core.load,
    save: core.save,
    saved: () => {},
    failed: (edit) => failed.push(edit),
  });
  core.failNext();
  saver.apply({ kind: "pin", id: "p1", appId: "chat" });
  saver.apply({ kind: "names", showNames: false });
  await core.release();
  expect(saver.failure()).toEqual({ kind: "pin", id: "p1", appId: "chat" });
  expect(failed).toHaveLength(1);
  // Only the failed pin is gone from what the editor shows; the next change waits and then saves.
  expect(saver.settings()).toMatchObject({ shortcuts: [], showNames: false });
  await core.release();
  expect(core.stored()).toMatchObject({ shortcuts: [], showNames: false });
  expect(saver.state()).toBe("failed");
  saver.retry();
  expect(saver.failure()).toBeUndefined();
  await core.release();
  expect(core.stored()).toMatchObject({ shortcuts: [{ appId: "chat" }], showNames: false });
  expect(saver.state()).toBe("saved");
});

test("a change with no effect sends nothing", async () => {
  const core = server(base());
  const saver = createRailSaver({ initial: base(), apps: () => apps, load: core.load, save: core.save, saved: () => {} });
  saver.apply({ kind: "visible", appId: "mail", visible: true });
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  expect(core.writes).toEqual([]);
  expect(saver.state()).toBe("saved");
});

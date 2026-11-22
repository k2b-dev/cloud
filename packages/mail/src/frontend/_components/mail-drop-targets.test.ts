import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MailCollaborator } from "../../service/collaboration";
import type { LocalTag } from "../../service/local-tags";
import type { MailFolderView } from "../../service/messages";
import {
  MAIL_DROP_LEVEL_SIZE,
  type MailDropContext,
  type MailDropTarget,
  mailDropView,
  readMailDropRecentFolders,
  rememberMailDropFolder,
} from "./mail-drop-targets";

const ME = "00000000-0000-4000-8000-000000000001";

const folder = (id: string, overrides: Partial<MailFolderView> = {}): MailFolderView => ({
  id,
  parentId: null,
  name: id,
  role: "other",
  providerRole: "other",
  configuredRole: null,
  selectable: true,
  display: "everywhere",
  effectiveDisplay: "everywhere",
  displayInheritedFromFolderId: null,
  displayNeutral: false,
  namespaceKinds: ["personal"],
  discoveryState: "active",
  missingSince: null,
  syncStatus: "current",
  total: 0,
  unread: 0,
  ...overrides,
});

const person = (id: string, displayName: string): MailCollaborator => ({ id, uid: id, displayName, avatarHash: null });
const tag = (id: string, name: string): LocalTag => ({
  id,
  mailboxId: "box",
  name,
  color: "#0369a1",
  revision: 1,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
});
const item = (overrides: Partial<MailDropContext["items"][number]> = {}): MailDropContext["items"][number] => ({
  conversationId: "c1",
  assigneeUserIds: [],
  activeFolderIds: ["inbox"],
  workStatus: "needs_action",
  localTags: [],
  ...overrides,
});

// Frequency order as the server sends it: the first eleven are the most frequent, then A–Z.
const FIRST = ["Jonas", "Mira", "Tom", "Anna", "Ben", "Finn", "Clara", "Kai", "Eva", "Greta", "Hanna"];
const people = (count: number) => [
  person(ME, "Me Myself"),
  ...Array.from({ length: count }, (_, index) => person(`p${index}`, `${FIRST[index] ?? `Name${String(index).padStart(3, "0")}`} Person`)),
];

const context = (overrides: Partial<MailDropContext> = {}): MailDropContext => ({
  locale: "de",
  currentUserId: ME,
  items: [item()],
  assignees: { people: people(17), more: false },
  teamMailbox: true,
  folders: [folder("inbox", { role: "inbox", name: "Posteingang" }), folder("claims", { name: "Reklamationen" })],
  folderName: (entry) => entry.name,
  tags: [tag("t1", "Rechnung"), tag("t2", "Dringend")],
  recentFolderIds: [],
  ...overrides,
});

const ids = (targets: MailDropTarget[]) => targets.map((target) => target.id);

describe("Mail drop targets", () => {
  test("a team mailbox offers five first-level targets with their second lines", () => {
    const view = mailDropView({ kind: "root" }, context());
    expect(ids(view.targets)).toEqual(["assign-me", "assign", "folder", "done", "tag"]);
    expect(view.targets.map((target) => [target.label, target.description ?? ""])).toEqual([
      ["Mir zuweisen", "Andere bleiben zuständig"],
      ["Jemand anderem zuweisen", "Kurz verweilen"],
      ["In Ordner verschieben", "Kurz verweilen"],
      ["Als erledigt markieren", ""],
      ["Tag hinzufügen", "Kurz verweilen"],
    ]);
  });

  test("a drop straight on Assign to someone else opens the assignment search", () => {
    const assign = mailDropView({ kind: "root" }, context()).targets.find((target) => target.id === "assign");
    expect(assign?.action).toEqual({ kind: "choose-assignee" });
    expect(assign?.level).toEqual({ kind: "assign" });
  });

  test("people who may not assign, and a personal mailbox, get no assignment targets", () => {
    expect(ids(mailDropView({ kind: "root" }, context({ assignees: null })).targets)).toEqual(["folder", "done", "tag"]);
    expect(ids(mailDropView({ kind: "root" }, context({ teamMailbox: false })).targets)).toEqual(["folder", "done", "tag"]);
  });

  test("locked targets stay in place and name why", () => {
    const view = mailDropView(
      { kind: "root" },
      context({ items: [item({ assigneeUserIds: [ME], workStatus: "done" }), item({ assigneeUserIds: ["p0", ME], workStatus: "done" })] }),
    );
    const me = view.targets.find((target) => target.id === "assign-me");
    const done = view.targets.find((target) => target.id === "done");
    expect(me).toMatchObject({ disabled: true, description: "Ist schon dir zugewiesen" });
    expect(done).toMatchObject({ disabled: true, description: "Ist schon erledigt" });
  });

  test("a selection is locked only when every dragged conversation already has the change", () => {
    const view = mailDropView({ kind: "root" }, context({ items: [item({ assigneeUserIds: [ME] }), item()] }));
    expect(view.targets.find((target) => target.id === "assign-me")).toMatchObject({
      disabled: false,
      description: "Andere bleiben zuständig",
    });
  });

  test("the people level shows the eleven most frequent, leaves out the dragging person, and offers the rest", () => {
    const view = mailDropView({ kind: "assign" }, context());
    expect(view.crumb).toBe("Jemand anderem zuweisen · Häufig");
    expect(view.targets[0]).toMatchObject({ id: "back", back: true, level: { kind: "root" } });
    expect(view.targets.slice(1, 12).map((target) => target.label.split(" ")[0])).toEqual(FIRST);
    expect(view.targets.some((target) => target.id === `person:${ME}`)).toBe(false);
    expect(view.targets.at(-1)).toMatchObject({
      id: "more",
      label: "Weitere 6 Personen",
      level: { kind: "assign-more", path: [] },
      action: { kind: "choose-assignee" },
    });
  });

  test("someone already responsible is named, and locked when responsible for every dragged conversation", () => {
    const some = mailDropView({ kind: "assign" }, context({ items: [item({ assigneeUserIds: ["p1"] }), item()] }));
    expect(some.targets.find((target) => target.id === "person:p1")).toMatchObject({ disabled: false, description: "Ist schon zuständig" });
    const all = mailDropView({ kind: "assign" }, context({ items: [item({ assigneeUserIds: ["p1"] })] }));
    expect(all.targets.find((target) => target.id === "person:p1")).toMatchObject({ disabled: true });
    expect(all.targets.find((target) => target.id === "person:p1")?.action).toEqual({ kind: "assign", userId: "p1", name: "Mira Person" });
  });

  test("sixty people split the rest into A–Z ranges of at most twelve", () => {
    const view = mailDropView({ kind: "assign-more", path: [] }, context({ assignees: { people: people(59), more: false } }));
    const ranges = view.targets.filter((target) => target.id.startsWith("range:"));
    expect(ranges).toHaveLength(4);
    expect(ranges.map((target) => target.description)).toEqual(["12 Personen", "12 Personen", "12 Personen", "12 Personen"]);
    expect(ranges[0]?.label).toBe("Name011 – Name022");
    const inner = mailDropView({ kind: "assign-more", path: [1] }, context({ assignees: { people: people(59), more: false } }));
    expect(inner.targets).toHaveLength(13);
    expect(inner.targets[0]).toMatchObject({ id: "back", level: { kind: "assign-more", path: [] } });
  });

  test("two hundred people nest their ranges so no level holds more than twelve targets", () => {
    const context200 = context({ assignees: { people: people(200), more: true } });
    const outer = mailDropView({ kind: "assign-more", path: [] }, context200);
    expect(outer.targets.filter((target) => !target.back && target.id !== "search").length).toBeLessThanOrEqual(MAIL_DROP_LEVEL_SIZE);
    // More than the drag holds: the search stays one drop away.
    expect(outer.targets.at(-1)).toMatchObject({ id: "search", action: { kind: "choose-assignee" } });
    const first = mailDropView({ kind: "assign-more", path: [0] }, context200);
    const leaf = first.targets.some((target) => target.level?.kind === "assign-more")
      ? mailDropView({ kind: "assign-more", path: [0, 0] }, context200)
      : first;
    expect(leaf.targets.filter((target) => target.action?.kind === "assign").length).toBeLessThanOrEqual(MAIL_DROP_LEVEL_SIZE);
    expect(mailDropView({ kind: "assign" }, context200).targets.at(-1)).toMatchObject({ id: "more", label: "Weitere Personen" });
  });

  test("a stale range path falls back to Back instead of failing", () => {
    expect(mailDropView({ kind: "assign-more", path: [9, 9] }, context()).targets).toEqual([
      expect.objectContaining({ id: "back", level: { kind: "assign" } }),
    ]);
  });

  test("folders list recently used ones first, lock where everything is already, and leave out unselectable ones", () => {
    const folders = [
      folder("inbox", { role: "inbox", name: "Posteingang" }),
      ...Array.from({ length: 14 }, (_, index) => folder(`f${index}`, { name: `Ordner ${String(index).padStart(2, "0")}` })),
      folder("parent", { name: "Nur Eltern", selectable: false }),
    ];
    const view = mailDropView({ kind: "folder" }, context({ folders, recentFolderIds: ["f9", "gone"] }));
    expect(view.crumb).toBe("In Ordner verschieben · Zuletzt genutzt");
    expect(ids(view.targets).slice(0, 4)).toEqual(["back", "folder:f9", "folder:inbox", "folder:f0"]);
    expect(view.targets.find((target) => target.id === "folder:inbox")).toMatchObject({ disabled: true, description: "Liegt schon hier" });
    expect(view.targets.some((target) => target.id === "folder:parent")).toBe(false);
    expect(view.targets.at(-1)).toMatchObject({ id: "more", label: "Weitere 4 Ordner", level: { kind: "folder-more", path: [] } });
    const more = mailDropView({ kind: "folder-more", path: [] }, context({ folders, recentFolderIds: ["f9"] }));
    expect(ids(more.targets)).toEqual(["back", "folder:f10", "folder:f11", "folder:f12", "folder:f13"]);
    expect(more.targets[1]?.action).toEqual({ kind: "move", folderId: "f10", name: "Ordner 10" });
  });

  test("tags lock where every dragged conversation has them; no tags means no tag target", () => {
    const view = mailDropView({ kind: "tag" }, context({ items: [item({ localTags: [tag("t1", "Rechnung")] })] }));
    expect(ids(view.targets)).toEqual(["back", "tag:t1", "tag:t2"]);
    expect(view.targets[1]).toMatchObject({ disabled: true, description: "Hat diesen Tag schon" });
    expect(view.targets[2]?.action).toEqual({ kind: "tag", tagId: "t2", name: "Dringend" });
    expect(ids(mailDropView({ kind: "root" }, context({ tags: [] })).targets)).toEqual(["assign-me", "assign", "folder", "done"]);
  });

  test("English names the same targets", () => {
    expect(mailDropView({ kind: "root" }, context({ locale: "en" })).targets.map((target) => target.label)).toEqual([
      "Assign to me",
      "Assign to someone else",
      "Move to folder",
      "Mark as done",
      "Add tag",
    ]);
  });
});

describe("Mail drop recent folders", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
    });
  });
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  test("remembers the latest folder first, once, per mailbox", () => {
    rememberMailDropFolder("box", "a");
    rememberMailDropFolder("box", "b");
    rememberMailDropFolder("box", "a");
    rememberMailDropFolder("other", "z");
    expect(readMailDropRecentFolders("box")).toEqual(["a", "b"]);
  });

  test("reads nothing from damaged storage", () => {
    globalThis.localStorage?.setItem("k2b-mail-drop-folders:box", "{not json");
    expect(readMailDropRecentFolders("box")).toEqual([]);
  });
});

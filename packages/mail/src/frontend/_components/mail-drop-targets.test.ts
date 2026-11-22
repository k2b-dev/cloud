import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MailCollaborator } from "../../service/collaboration";
import type { LocalTag } from "../../service/local-tags";
import type { MailFolderView } from "../../service/messages";
import {
  type MailDropContext,
  type MailDropTarget,
  mailDraggedRows,
  mailDropFolderTargets,
  mailDropPeople,
  mailDropRoot,
  mailDropTags,
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
    const targets = mailDropRoot(context());
    expect(ids(targets)).toEqual(["assign-me", "assign", "folder", "done", "tag"]);
    expect(targets.map((target) => [target.label, target.description ?? ""])).toEqual([
      ["Mir zuweisen", "Andere bleiben zuständig"],
      ["Jemand anderem zuweisen", ""],
      ["In Ordner verschieben", ""],
      ["Als erledigt markieren", ""],
      ["Tag hinzufügen", ""],
    ]);
  });

  test("a drop straight on Assign to someone else opens the assignment search; resting opens the people", () => {
    const assign = mailDropRoot(context()).find((target) => target.id === "assign");
    expect(assign?.action).toEqual({ kind: "choose-assignee" });
    expect(assign?.level).toBe("assign");
  });

  test("people who may not assign, and a personal mailbox, get no assignment targets and no people", () => {
    expect(ids(mailDropRoot(context({ assignees: null })))).toEqual(["folder", "done", "tag"]);
    expect(ids(mailDropRoot(context({ teamMailbox: false })))).toEqual(["folder", "done", "tag"]);
    expect(mailDropPeople(context({ assignees: null })).targets).toEqual([]);
  });

  test("locked targets stay in place and name why", () => {
    const targets = mailDropRoot(
      context({ items: [item({ assigneeUserIds: [ME], workStatus: "done" }), item({ assigneeUserIds: ["p0", ME], workStatus: "done" })] }),
    );
    expect(targets.find((target) => target.id === "assign-me")).toMatchObject({ disabled: true, description: "Ist schon dir zugewiesen" });
    expect(targets.find((target) => target.id === "done")).toMatchObject({ disabled: true, description: "Ist schon erledigt" });
  });

  test("a selection is locked only when every dragged conversation already has the change", () => {
    const targets = mailDropRoot(context({ items: [item({ assigneeUserIds: [ME] }), item()] }));
    expect(targets.find((target) => target.id === "assign-me")).toMatchObject({ disabled: false, description: "Andere bleiben zuständig" });
  });

  test("people come most frequent first as the server orders them, then A–Z, without the dragging person", () => {
    const { targets, more } = mailDropPeople(context({ assignees: { people: people(17), more: true } }));
    expect(more).toBe(true);
    expect(targets.slice(0, 11).map((target) => target.label.split(" ")[0])).toEqual(FIRST);
    const rest = targets.slice(11).map((target) => target.label);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b, "de")));
    expect(targets.some((target) => target.id === `person:${ME}`)).toBe(false);
  });

  test("someone already responsible is named, and locked when responsible for every dragged conversation", () => {
    const some = mailDropPeople(context({ items: [item({ assigneeUserIds: ["p1"] }), item()] })).targets;
    expect(some.find((target) => target.id === "person:p1")).toMatchObject({ disabled: false, description: "Ist schon zuständig" });
    const all = mailDropPeople(context({ items: [item({ assigneeUserIds: ["p1"] })] })).targets;
    expect(all.find((target) => target.id === "person:p1")).toMatchObject({ disabled: true });
    expect(all.find((target) => target.id === "person:p1")?.action).toEqual({ kind: "assign", userId: "p1", name: "Mira Person" });
  });

  test("folders list recently used ones first, lock where everything is already, and leave out unselectable ones", () => {
    const folders = [
      folder("inbox", { role: "inbox", name: "Posteingang" }),
      ...Array.from({ length: 14 }, (_, index) => folder(`f${index}`, { name: `Ordner ${String(index).padStart(2, "0")}` })),
      folder("parent", { name: "Nur Eltern", selectable: false }),
    ];
    const targets = mailDropFolderTargets(context({ folders, recentFolderIds: ["f13", "gone"] }));
    expect(ids(targets).slice(0, 3)).toEqual(["folder:f13", "folder:inbox", "folder:f0"]);
    expect(targets).toHaveLength(15);
    expect(targets.find((target) => target.id === "folder:inbox")).toMatchObject({ disabled: true, description: "Liegt schon hier" });
    expect(targets.some((target) => target.id === "folder:parent")).toBe(false);
    // After the first page, the rest stands A–Z.
    expect(ids(targets.slice(11))).toEqual(["folder:f9", "folder:f10", "folder:f11", "folder:f12"]);
    expect(targets[1]?.action).toEqual({ kind: "move", folderId: "inbox", name: "Posteingang" });
  });

  test("tags lock where every dragged conversation has them; no tags means no tag target", () => {
    const targets = mailDropTags(context({ items: [item({ localTags: [tag("t1", "Rechnung")] })] }));
    expect(ids(targets)).toEqual(["tag:t1", "tag:t2"]);
    expect(targets[0]).toMatchObject({ disabled: true, description: "Hat diesen Tag schon" });
    expect(targets[1]?.action).toEqual({ kind: "tag", tagId: "t2", name: "Dringend" });
    expect(ids(mailDropRoot(context({ tags: [] })))).toEqual(["assign-me", "assign", "folder", "done"]);
  });

  test("English names the same targets", () => {
    expect(mailDropRoot(context({ locale: "en" })).map((target) => target.label)).toEqual([
      "Assign to me",
      "Assign to someone else",
      "Move to folder",
      "Mark as done",
      "Add tag",
    ]);
  });
});

describe("Mail dragged rows", () => {
  // A message list: the question sits in the Inbox, its conversation's newer reply has its own row from Sent.
  const rows = [
    { id: "Msg003", conversationId: "Conv01" },
    { id: "Msg002", conversationId: "Conv01" },
    { id: "Msg004", conversationId: "Conv02" },
    { id: "Msg005", conversationId: "Conv03" },
  ];

  test("a drag carries the dragged row itself, not another row of its conversation", () => {
    expect(mailDraggedRows(rows, new Set(), "Msg002")).toEqual([{ id: "Msg002", conversationId: "Conv01" }]);
  });

  test("a row of a selection carries every selected row; a row outside it only itself", () => {
    expect(mailDraggedRows(rows, new Set(["Conv02", "Conv03"]), "Msg004").map((row) => row.id)).toEqual(["Msg004", "Msg005"]);
    expect(mailDraggedRows(rows, new Set(["Conv02", "Conv03"]), "Msg002").map((row) => row.id)).toEqual(["Msg002"]);
  });

  test("a row that left the list carries nothing", () => {
    expect(mailDraggedRows(rows, new Set(), "gone")).toEqual([]);
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

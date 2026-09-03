import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { PermissionLevel, User } from "@valentinkolb/cloud/contracts";
import type { AuthContext } from "@valentinkolb/cloud/server";
import * as cloudServices from "@valentinkolb/cloud/services";
import { Hono } from "hono";
import type { PresentationMode } from "../../lib/presentation-mode";
import { notebooksService } from "../../service";
import * as notebookStore from "../../service/notebooks";
import * as noteStore from "../../service/notes";
import { loadNotebookPageData } from "./page-data";

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "reader",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Book",
  sn: "Reader",
  displayName: "Book Reader",
  mail: "reader@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;
const timestamp = "2026-09-03T08:00:00.000Z";
const notebook = {
  id: "22222222-2222-4222-8222-222222222222",
  shortId: "book01",
  name: "Handbook",
  description: null,
  icon: null,
  homepageNoteId: null,
  homepageNoteShortId: null,
  defaultPresentationMode: "write" as PresentationMode,
  defaultNoteTitleTemplate: "Untitled",
  createdBy: user.id,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const note = {
  id: "33333333-3333-4333-8333-333333333333",
  shortId: "note01",
  notebookId: notebook.id,
  parentId: null,
  title: "Welcome",
  position: 0,
  hasChildren: false,
  yjsSnapshotAt: timestamp,
  contentMd: "# Welcome\n\nOur **handbook**.\n\n#team",
  yjsSnapshot: "collaboration-state-not-for-book",
  createdBy: user.id,
  createdAt: timestamp,
  updatedAt: timestamp,
  lockedAt: null as string | null,
};
const activeSpies: Array<{ mockRestore(): void }> = [];
const track = <T extends { mockRestore(): void }>(spy: T): T => {
  activeSpies.push(spy);
  return spy;
};
afterEach(() => {
  for (const spy of activeSpies.splice(0)) spy.mockRestore();
});

function fixtures(permission: PermissionLevel, defaultPresentationMode: PresentationMode = "write", locked = false) {
  const currentNotebook = { ...notebook, defaultPresentationMode };
  const currentNote = { ...note, lockedAt: locked ? timestamp : null };
  track(spyOn(cloudServices, "get")).mockResolvedValue("https://cloud.example.test");
  track(spyOn(notebooksService.notebook, "getByShortId")).mockResolvedValue(currentNotebook);
  track(spyOn(notebooksService.notebook, "get")).mockResolvedValue(currentNotebook);
  track(spyOn(notebooksService.notebook.permission, "get")).mockResolvedValue(permission);
  track(spyOn(notebookStore, "canAccess")).mockResolvedValue(permission !== "none");
  track(spyOn(notebooksService.workspaceEvents, "latestCursor")).mockResolvedValue("1-0");
  track(spyOn(notebooksService.note, "getTree")).mockResolvedValue([{ ...currentNote, children: [] }]);
  track(spyOn(notebooksService.note, "getByShortId")).mockResolvedValue(currentNote);
  track(spyOn(noteStore, "getWithContentByShortId")).mockResolvedValue(currentNote);
  track(spyOn(notebooksService.note, "getWithContentByShortId")).mockResolvedValue(currentNote);
  track(spyOn(notebooksService.attachment, "count")).mockResolvedValue(0);
  track(spyOn(notebooksService.tag, "listForNotebook")).mockResolvedValue([{ tag: "team", count: 1 }]);
  track(spyOn(notebooksService.note.favorites, "listIds")).mockResolvedValue([]);
  const backlinks = track(spyOn(notebooksService.note.backlinks, "list")).mockResolvedValue([]);
  const comments = track(spyOn(notebooksService.note.comments, "listPage")).mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    perPage: 30,
    hasNext: false,
  });
  const graph = track(spyOn(notebooksService.notebook, "graph"));
  const versions = track(spyOn(notebooksService.note.versions, "list"));
  return { backlinks, comments, graph, versions };
}

async function load(mode?: string, path = "/app/notebooks/book01/notes/note01") {
  const app = new Hono<AuthContext & { Variables: { page: { title?: string } } }>();
  let result: Awaited<ReturnType<typeof loadNotebookPageData>> | undefined;
  app.get("/app/notebooks/:id/notes/:noteId", async (c) => {
    c.set("actor", { kind: "user", user });
    result = await loadNotebookPageData(c);
    return c.body(null, 204);
  });
  const response = await app.request(`https://cloud.example.test${path}${mode ? `?mode=${mode}` : ""}`, {
    headers: { "Accept-Language": "de" },
  });
  expect(response.status).toBe(204);
  if (!result || result.kind !== "ok") throw new Error(`Expected page data, got ${result?.kind}`);
  return result;
}

describe("notebook page presentation authorization", () => {
  for (const mode of [undefined, "write", "readonly", "graph", "versions", "book"]) {
    test(`read grants always load Book instead of ${mode ?? "the Write default"}`, async () => {
      const calls = fixtures("read");
      const data = await load(mode);
      expect(data.presentationMode).toBe("book");
      expect(data.isBookMode).toBe(true);
      expect(data.readonlyMode).toBe(true);
      expect(data.isGraphMode).toBe(false);
      expect(data.isVersionsMode).toBe(false);
      expect(data.showDetailPanel).toBe(false);
      expect(data.selectedRouteState).toBeNull();
      expect(data.selectedNote?.contentMd).toBeNull();
      expect(data.selectedNote?.yjsSnapshot).toBeNull();
      expect(data.bookHtml).toContain("<strong>handbook</strong>");
      expect(data.ctx.tags).toEqual([{ tag: "team", count: 1 }]);
      expect(data.initialCommentsPage).toBeNull();
      expect(calls.backlinks).not.toHaveBeenCalled();
      expect(calls.comments).not.toHaveBeenCalled();
      expect(calls.graph).not.toHaveBeenCalled();
      expect(calls.versions).not.toHaveBeenCalled();
    });
  }

  for (const permission of ["write", "admin"] as const) {
    for (const mode of ["book", "write", "readonly"] as const) {
      test(`${permission} honors the ${mode} notebook default`, async () => {
        fixtures(permission, mode);
        const data = await load();
        expect(data.presentationMode).toBe(mode);
        expect(data.isBookMode).toBe(mode === "book");
        expect(data.readonlyMode).toBe(mode !== "write");
        expect(data.showDetailPanel).toBe(mode !== "book");
        expect(data.selectedRouteState !== null).toBe(mode !== "book");
      });
    }
  }

  for (const mode of ["write", "readonly"] as const) {
    test(`an author's explicit ${mode} view overrides the Book default`, async () => {
      fixtures("write", "book");
      const data = await load(mode);
      expect(data.presentationMode).toBe(mode);
      expect(data.bookHtml).toBeNull();
      expect(data.showDetailPanel).toBe(true);
    });
  }

  test("an explicit Book view overrides the Write default", async () => {
    fixtures("admin", "write");
    const data = await load("book");
    expect(data.presentationMode).toBe("book");
    expect(data.selectedRouteState).toBeNull();
  });

  test("a locked note downgrades explicit Write to the existing Read-only view", async () => {
    fixtures("admin", "book", true);
    const data = await load("write");
    expect(data.presentationMode).toBe("readonly");
    expect(data.readonlyMode).toBe(true);
    expect(data.isBookMode).toBe(false);
    expect(data.showDetailPanel).toBe(true);
  });
});

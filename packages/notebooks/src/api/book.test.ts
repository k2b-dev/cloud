import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { User } from "@valentinkolb/cloud/contracts";
import type { Notebook } from "../service/notebooks";

// Isolate import-time middleware spies while exercising the actual auth,
// validators, permission checks, status mapping and response headers.
if (process.env.NOTEBOOKS_BOOK_API_TEST !== "1") {
  test("Book refresh and block preview API contract", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, NOTEBOOKS_BOOK_API_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
  }, 30_000);
} else {
  await import("../frontend/[id]/_components/detail/ssr-test-plugin");
  const server = await import("@valentinkolb/cloud/server");
  const { oauthTokens } = await import("@valentinkolb/cloud/services");
  const rateLimit = spyOn(server, "rateLimit").mockReturnValue(async (_c, next) => next());
  const { notebooksService } = await import("../service");
  const book = await import("../service/book");
  const routes = await import("../service/book-route");
  const { default: app } = await import("./index");

  const user: User = {
    id: "11111111-1111-4111-8111-111111111111",
    uid: "book-api-test",
    roles: ["user"],
    provider: "local",
    profile: "user",
    givenname: "Book",
    sn: "Reader",
    displayName: "Book Reader",
    mail: "book@example.test",
    avatarHash: null,
    ipa: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
  };
  const notebook: Notebook = {
    id: "22222222-2222-4222-8222-222222222222",
    shortId: "book01",
    name: "Handbook",
    description: null,
    icon: null,
    homepageNoteId: null,
    homepageNoteShortId: null,
    scriptsEnabled: false,
    defaultPresentationMode: "write",
    defaultNoteTitleTemplate: "Untitled",
    createdBy: user.id,
    createdAt: "2026-09-03T10:00:00Z",
    updatedAt: "2026-09-03T10:00:00Z",
  };
  const snapshot = {
    href: "/app/notebooks/book01/notes/note01?mode=book",
    html: "<h1>Welcome</h1>",
    title: "Welcome",
    notebookName: "Handbook",
    selectedNoteId: "note01",
    tree: [],
    tags: [],
    canWrite: false,
    locked: false,
    cursor: "1-0",
  };
  const token = spyOn(oauthTokens, "verifyAccessToken");
  const getNotebook = spyOn(notebooksService.notebook, "getByShortId");
  const permission = spyOn(notebooksService.notebook.permission, "get");
  const loadRoute = spyOn(routes, "loadBookRoute");
  const loadPreview = spyOn(book, "loadBookBlockPreview");
  const headers = { authorization: "Bearer book-api-test", "content-type": "application/json", "x-cloud-locale": "de" };
  const refresh = (href = snapshot.href) => app.request(`/book01/book?${new URLSearchParams({ href })}`, { headers });
  const preview = (body: unknown = {}) =>
    app.request("/book01/notes/note01/block-preview", { method: "POST", headers, body: JSON.stringify(body) });

  beforeEach(() => {
    token.mockReset().mockResolvedValue({ kind: "user", payload: {}, user, scopes: [] });
    getNotebook.mockReset().mockResolvedValue(notebook);
    permission.mockReset().mockResolvedValue("read");
    loadRoute.mockReset().mockResolvedValue({ kind: "ok", snapshot });
    loadPreview.mockReset().mockResolvedValue({
      kind: "ok",
      preview: { markdown: "# Welcome", blocks: [], headings: [{ id: "heading-welcome", line: 1 }], diagnostics: [] },
    });
  });
  afterAll(() => {
    for (const spy of [token, getNotebook, permission, loadRoute, loadPreview, rateLimit]) spy.mockRestore();
  });

  describe("Book HTTP boundary", () => {
    test("serves read snapshots privately with request locale and public notebook resolution", async () => {
      const response = await refresh();
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.json()).toEqual(snapshot);
      expect(loadRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          notebookId: notebook.id,
          notebookShortId: notebook.shortId,
          userId: user.id,
          locale: "de",
          href: snapshot.href,
        }),
      );
    });

    test("denies both endpoints before service rendering when notebook access is absent", async () => {
      permission.mockResolvedValue("none");
      expect((await refresh()).status).toBe(403);
      expect((await preview()).status).toBe(403);
      expect(loadRoute).not.toHaveBeenCalled();
      expect(loadPreview).not.toHaveBeenCalled();
    });

    test("read grants can preview saved content but cannot submit any draft", async () => {
      const saved = await preview();
      expect(saved.status).toBe(200);
      expect(saved.headers.get("Cache-Control")).toBe("private, no-store");
      expect(loadPreview).toHaveBeenCalledWith({
        notebookId: notebook.id,
        notebookShortId: "book01",
        noteShortId: "note01",
        userId: user.id,
        locale: "de",
      });
      loadPreview.mockClear();
      expect((await preview({ markdown: "# Draft" })).status).toBe(403);
      expect((await preview({ markdown: "" })).status).toBe(403);
      expect(loadPreview).not.toHaveBeenCalled();
    });

    test("write grants submit drafts; locked or vanished notes map to 403 and 404", async () => {
      permission.mockResolvedValue("write");
      expect((await preview({ markdown: "# Draft" })).status).toBe(200);
      expect(loadPreview).toHaveBeenCalledWith(expect.objectContaining({ markdown: "# Draft", locale: "de" }));
      loadPreview.mockResolvedValue({ kind: "denied" });
      expect((await preview({ markdown: "# Draft" })).status).toBe(403);
      loadPreview.mockResolvedValue({ kind: "not_found" });
      expect((await preview({ markdown: "# Draft" })).status).toBe(404);
    });

    test("malformed and oversized input is rejected before rendering", async () => {
      permission.mockResolvedValue("write");
      for (const body of [{ markdown: null }, { markdown: 3 }, { content: "unknown field" }])
        expect((await preview(body)).status).toBe(400);
      expect((await preview({ markdown: "x".repeat(8_000_001) })).status).toBe(413);
      expect(loadPreview).not.toHaveBeenCalled();
      expect((await app.request("/book01/book", { headers })).status).toBe(400);
      expect(loadRoute).not.toHaveBeenCalled();
    });

    test("refresh invalid and unavailable results map to stable HTTP statuses", async () => {
      for (const [kind, status] of [
        ["invalid", 400],
        ["not_found", 404],
        ["denied", 403],
      ] as const) {
        loadRoute.mockResolvedValue({ kind });
        expect((await refresh()).status).toBe(status);
      }
    });
  });
}

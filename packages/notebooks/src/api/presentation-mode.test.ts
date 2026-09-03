import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { User } from "@valentinkolb/cloud/contracts";
import type { Notebook } from "../service/notebooks";

// The API installs middleware at import time. Isolate its rate-limit stub from
// other suites while exercising the real authentication, validator, and route.
if (process.env.NOTEBOOKS_PRESENTATION_API_TEST !== "1") {
  test("notebook presentation API permissions and validation", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, NOTEBOOKS_PRESENTATION_API_TEST: "1" },
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
  const { default: app } = await import("./index");

  const user: User = {
    id: "11111111-1111-4111-8111-111111111111",
    uid: "notebook-presentation-test",
    roles: ["user"],
    provider: "local",
    profile: "user",
    givenname: "Notebook",
    sn: "Test",
    displayName: "Notebook Test",
    mail: "notebook@example.test",
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
    createdAt: "2026-09-03T10:00:00.000Z",
    updatedAt: "2026-09-03T10:00:00.000Z",
  };
  const token = spyOn(oauthTokens, "verifyAccessToken");
  const getNotebook = spyOn(notebooksService.notebook, "getByShortId");
  const permission = spyOn(notebooksService.notebook.permission, "get");
  const update = spyOn(notebooksService.notebook, "update");
  const patch = (body: unknown) =>
    app.request("/book01", {
      method: "PATCH",
      headers: { authorization: "Bearer notebook-presentation-test", "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    token.mockReset().mockResolvedValue({ kind: "user", payload: {}, user, scopes: [] });
    getNotebook.mockReset().mockResolvedValue(notebook);
    permission.mockReset().mockResolvedValue("write");
    update.mockReset().mockImplementation(async ({ data }) => ({ ok: true, data: { ...notebook, ...data } }));
  });
  afterAll(() => {
    for (const spy of [token, getNotebook, permission, update, rateLimit]) spy.mockRestore();
  });

  describe("notebook presentation API", () => {
    test("denies changing the default for notebook writers", async () => {
      expect((await patch({ defaultPresentationMode: "book" })).status).toBe(403);
      expect(update).not.toHaveBeenCalled();
    });

    test("lets notebook admins change every supported default", async () => {
      permission.mockResolvedValue("admin");
      for (const defaultPresentationMode of ["book", "write", "readonly"]) {
        const response = await patch({ defaultPresentationMode });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ id: "book01", defaultPresentationMode });
        expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ id: notebook.id, data: { defaultPresentationMode } }));
      }
    });

    test("keeps ordinary notebook edits available to writers", async () => {
      const response = await patch({ name: "Renamed" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ name: "Renamed", defaultPresentationMode: "write" });
    });

    test("rejects malformed defaults before invoking the service", async () => {
      permission.mockResolvedValue("admin");
      for (const value of ["editor", "READONLY", "", null, 1]) {
        expect((await patch({ defaultPresentationMode: value })).status).toBe(400);
      }
      expect(update).not.toHaveBeenCalled();
    });
  });
}

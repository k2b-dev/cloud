import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import type { ServiceAccount } from "@k2b/cloud/services";
import { toBase64 } from "@k2b/cloud/shared-text";
import * as Y from "yjs";
import { NoteTableActionErrorSchema, NoteTableActionResponseSchema } from "../lib/table-actions";
import type { Notebook } from "../service/notebooks";

if (process.env.NOTEBOOKS_TABLE_ACTION_API_TEST !== "1") {
  test("table action authentication, ownership, transport and localized outcomes", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, NOTEBOOKS_TABLE_ACTION_API_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
  });
} else {
  await import("../frontend/[id]/_components/detail/ssr-test-plugin");
  const server = await import("@k2b/cloud/server");
  const { oauthTokens } = await import("@k2b/cloud/services");
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
    defaultPresentationMode: "write",
    noteDeletePermission: "write",
    defaultNoteTitleTemplate: "Untitled",
    createdBy: user.id,
    createdAt: "2026-09-03T10:00:00.000Z",
    updatedAt: "2026-09-03T10:00:00.000Z",
  };

  const token = spyOn(oauthTokens, "verifyAccessToken");
  const getNotebook = spyOn(notebooksService.notebook, "getByShortId");
  const permission = spyOn(notebooksService.notebook.permission, "get");
  const getNote = spyOn(notebooksService.note, "getByShortId");
  const action = spyOn(notebooksService.note, "tableAction");
  const anchor = toBase64(Y.encodeRelativePosition(new Y.RelativePosition(null, null, Y.createID(100, 1), 0)));
  const request = {
    restoreRevision: "0",
    actionId: "44444444-4444-4444-8444-444444444444",
    intent: { action: "completeColumns", table: { headerBreak: anchor, separatorHyphen: anchor } },
  };
  const note = {
    id: "33333333-3333-4333-8333-333333333333",
    notebookId: notebook.id,
    shortId: "note01",
    parentId: null,
    title: "Table",
    position: 0,
    hasChildren: false,
    yjsSnapshotAt: null,
    historyIncomplete: false,
    contentMd: null,
    createdBy: user.id,
    createdAt: notebook.createdAt,
    updatedAt: notebook.updatedAt,
    lockedAt: null,
  };
  const post = (body: unknown = request, locale = "de-CH", authenticated = true) =>
    app.request("/book01/notes/note01/table-action", {
      method: "POST",
      headers: {
        ...(authenticated ? { authorization: "Bearer table-test" } : {}),
        "content-type": "application/json",
        "x-cloud-locale": locale,
      },
      body: JSON.stringify(body),
    });
  beforeEach(() => {
    token.mockReset().mockResolvedValue({ kind: "user", payload: {}, user, scopes: [] });
    getNotebook.mockReset().mockResolvedValue(notebook);
    permission.mockReset().mockResolvedValue("write");
    getNote.mockReset().mockResolvedValue(note);
    action.mockReset().mockResolvedValue({ ok: true, data: { changed: false, cursor: null, receipt: null } });
  });
  afterAll(() => {
    for (const spy of [token, getNotebook, permission, getNote, action, rateLimit]) spy.mockRestore();
  });

  test("requires authentication and normal write permission", async () => {
    expect((await post(request, "en", false)).status).toBe(401);
    permission.mockResolvedValue("read");
    expect((await post()).status).toBe(403);
    expect(action).not.toHaveBeenCalled();
  });
  test("rejects notes from another authorized notebook without calling the action", async () => {
    getNote.mockResolvedValue({ ...note, notebookId: "other" });
    expect((await post()).status).toBe(404);
    expect(action).not.toHaveBeenCalled();
  });
  test("validates intents before service entry", async () => {
    for (const body of [
      { ...request, actionId: "bad" },
      { ...request, restoreRevision: "bad" },
      { ...request, intent: { ...request.intent, table: { ...request.intent.table, headerBreak: "bad" } } },
      { ...request, intent: { ...request.intent, row: 3 } },
    ])
      expect((await post(body)).status).toBe(400);
    expect(action).not.toHaveBeenCalled();
  });
  test("resolves public IDs and forwards decoded anchors, actor, audit and request cancellation", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(NoteTableActionResponseSchema.parse(await response.json())).toEqual({ changed: false, cursor: null, receipt: null });
    expect(action).toHaveBeenCalledWith({
      notebookId: notebook.id,
      noteId: note.id,
      permission: "write",
      createdBy: user.id,
      actor: { kind: "user", id: user.id },
      signal: expect.any(AbortSignal),
      actionId: request.actionId,
      restoreRevision: "0",
      intent: { action: "completeColumns", table: { headerBreak: expect.any(Uint8Array), separatorHyphen: expect.any(Uint8Array) } },
    });
  });
  test("caps service-account access by credential scopes and enforces notebook binding", async () => {
    const account: ServiceAccount = {
      id: "55555555-5555-4555-8555-555555555555",
      name: "Table agent",
      kind: "resource_bound",
      status: "active",
      delegatedUserId: null,
      appId: "notebooks",
      resourceType: "notebook",
      resourceId: notebook.id,
      createdBy: user.id,
      createdAt: notebook.createdAt,
    };
    token.mockResolvedValue({ kind: "service_account", payload: {}, serviceAccount: account, delegatedUser: null, scopes: ["read"] });
    expect((await post()).status).toBe(403);
    token.mockResolvedValue({
      kind: "service_account",
      payload: {},
      serviceAccount: { ...account, resourceId: note.id },
      delegatedUser: null,
      scopes: ["write"],
    });
    expect((await post()).status).toBe(403);
    expect(action).not.toHaveBeenCalled();
    token.mockResolvedValue({ kind: "service_account", payload: {}, serviceAccount: account, delegatedUser: null, scopes: ["write"] });
    expect((await post()).status).toBe(200);
    expect(action).toHaveBeenLastCalledWith(
      expect.objectContaining({ createdBy: null, actor: { kind: "service_account", id: account.id } }),
    );
  });
  test("localizes stable rejection codes and returns accepted receipts with exact persistence details", async () => {
    const failure = {
      ok: false as const,
      error: "target deleted",
      status: 409 as const,
      code: "table_target_rejected" as const,
      accepted: false,
      cursor: null,
      receipt: null,
    };
    action.mockResolvedValue(failure);
    const rejected = await post();
    expect(rejected.status).toBe(409);
    const problem = NoteTableActionErrorSchema.parse(await rejected.json());
    expect(problem).toMatchObject({ code: failure.code, accepted: false });
    expect(problem).not.toHaveProperty("detail");
    expect(problem.message).toContain("Text blieb erhalten");
    const receipt = { actionId: request.actionId, update: "AQID" };
    action.mockResolvedValue({
      ...failure,
      error: "Failed to persist note edit: projection failed",
      status: 500,
      code: "table_action_persist_failed",
      accepted: true,
      cursor: "cursor",
      receipt,
    });
    const accepted = await post();
    expect(accepted.status).toBe(500);
    const persisted = NoteTableActionErrorSchema.parse(await accepted.json());
    expect(persisted).toMatchObject({
      code: "table_action_persist_failed",
      accepted: true,
      cursor: "cursor",
      receipt,
    });
    expect(persisted.message).toContain("Wiederhole sie nicht");
    action.mockResolvedValue({ ...failure, status: 500, code: "table_action_outcome_unknown", accepted: null });
    const unknown = NoteTableActionErrorSchema.parse(await (await post()).json());
    expect(unknown.accepted).toBeNull();
    expect(unknown.message).toContain("möglicherweise angenommen");
  });
}

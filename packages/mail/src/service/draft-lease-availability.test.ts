import { afterEach, beforeEach, expect, mock, setSystemTime, test } from "bun:test";
import { UserSchema } from "@k2b/cloud/contracts";
import { err, fail, ok } from "@k2b/stdlib";
import type { MailRequestContext } from "./auth";

// Module fixtures stay in a child process so they cannot replace another suite's real Cloud clients.
if (process.env.MAIL_LEASE_AVAILABILITY_CHILD !== "1") {
  test("draft lease availability keeps concurrent reads independent of the state mutex", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, MAIL_LEASE_AVAILABILITY_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
  });
} else {
  const now = new Date("2026-11-12T02:00:00.000Z");
  const person = (id: string) =>
    UserSchema.parse({
      id,
      uid: id,
      provider: "local",
      profile: "user",
      roles: ["user"],
      givenname: id,
      sn: "Person",
      displayName: id,
      mail: null,
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    });
  const user = person("caller");
  const other = person("collaborator");
  const context: MailRequestContext = { actor: { kind: "user", user }, accessSubject: { type: "user", userId: user.id } };
  let holder: typeof user | null = null;
  let callerAllowed = true;
  let holderAllowed = true;
  let shared = false;
  let stateLocked = true;
  const access = mock(async (caller: MailRequestContext) => {
    const allowed = caller.actor.kind === "user" && caller.actor.user.id === user.id ? callerAllowed : holderAllowed;
    return allowed ? ok() : fail(err.forbidden("No draft write access"));
  });
  const remove = mock(async () => true);
  const snapshot = mock(async () => ({
    entries: holder
      ? [
          {
            key: "lease",
            updatedAt: now,
            value: {
              holder: { kind: "user", id: holder.id, displayName: holder.displayName },
              token: "lease-token",
              acquiredAt: now.getTime(),
              lock: { resource: "draft", ownerToken: "lock-token", fence: "1", expiresAt: new Date(now.getTime() + 60_000).toISOString() },
            },
          },
        ]
      : [],
  }));
  // Model another lease-state operation holding the mutex: a reader must not consume its retry budget.
  const withLock = mock(async (_lock: unknown, operation: () => Promise<unknown>) => (stateLocked ? undefined : operation()));
  const release = mock(async () => true);
  const fakeSync = { ephemeral: () => ({ snapshot, delete: remove }), mutex: () => ({ withLock, release }) };
  mock.module("@k2b/cloud", () => ({
    sql: async () => [{ id: "draft", edit_mode: shared ? "shared" : "lock" }],
    lazySync: (declare: (sync: typeof fakeSync) => unknown) => () => declare(fakeSync),
  }));
  mock.module("@k2b/cloud/services", () => ({ accounts: { users: { get: async () => other } } }));
  mock.module("./access", () => ({ requireDraftAccess: access }));
  mock.module("./live", () => ({ mailLive: { wake() {} } }));
  const { requireDraftLeaseAvailable, getDraftLease } = await import("./draft-leases");
  const target = { context, mailboxId: "mailbox", draftId: "draft" };
  beforeEach(() => {
    setSystemTime(now);
    holder = null;
    callerAllowed = true;
    holderAllowed = true;
    shared = false;
    stateLocked = true;
    access.mockClear();
    snapshot.mockClear();
    withLock.mockClear();
    remove.mockClear();
    release.mockClear();
  });
  afterEach(() => setSystemTime());

  test("concurrent reads never take the lease-state mutex", async () => {
    const results = await Promise.all(Array.from({ length: 11 }, () => requireDraftLeaseAvailable(target)));
    for (const result of results) expect(result.ok).toBe(true);
    expect(withLock).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
  test("another active editor remains a held conflict; its own editor may continue", async () => {
    holder = other;
    expect(await requireDraftLeaseAvailable(target)).toMatchObject({ ok: false, error: { code: "DRAFT_LEASE_HELD", status: 409 } });
    holder = user;
    expect((await requireDraftLeaseAvailable(target)).ok).toBe(true);
    expect(withLock).not.toHaveBeenCalled();
  });
  test("a revoked holder no longer blocks writes and readers never remove its state", async () => {
    holder = other;
    holderAllowed = false;
    expect((await requireDraftLeaseAvailable(target)).ok).toBe(true);
    expect(remove).not.toHaveBeenCalled();
  });
  test("a serialized lease lookup still removes a revoked holder", async () => {
    holder = other;
    holderAllowed = false;
    stateLocked = false;
    expect(await getDraftLease(target)).toEqual({ ok: true, data: null });
    expect(withLock).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith({ tenantId: "draft", key: "lease" });
    expect(release).toHaveBeenCalledTimes(1);
  });
  test("permission denial and shared editing keep their existing behavior", async () => {
    callerAllowed = false;
    expect(await requireDraftLeaseAvailable(target)).toMatchObject({ ok: false, error: { status: 403 } });
    expect(snapshot).not.toHaveBeenCalled();
    callerAllowed = true;
    shared = true;
    holder = other;
    expect((await requireDraftLeaseAvailable(target)).ok).toBe(true);
    expect(snapshot).not.toHaveBeenCalled();
  });
  test("a failed lease read remains visible and state-changing readers still serialize", async () => {
    snapshot.mockRejectedValueOnce(new Error("Store unavailable"));
    expect(await requireDraftLeaseAvailable(target)).toMatchObject({ ok: false, error: { status: 500 } });
    expect(await getDraftLease(target)).toMatchObject({ ok: false, error: { code: "DRAFT_LEASE_BUSY", status: 409 } });
    expect(withLock).toHaveBeenCalledTimes(1);
  });
}

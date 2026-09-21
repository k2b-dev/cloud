import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Filegate, FilegateError, type RootClient } from "@k2b/filegate";
import { DirectSession, putDirect } from "@k2b/filegate/utils";
import { suiteFor, testInfra } from "../../../scripts/fixtures/test-infra";
import { localFilegateToken } from "./private-database";

// Runs against the configured test Filegate in its own prefix. Never use application fixtures.
const suite = suiteFor("filegate");
const prefix = `filesv2-slice-${randomUUID()}`;
const transfer = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, credentials: "omit", signal: AbortSignal.timeout(10_000) }),
  { preconnect: fetch.preconnect },
);
const statuses: Record<string, unknown> = {};
let client: Filegate;
let root: RootClient;
let freeipa: RootClient;
let ownsFreeipaPrefix = false;
let ownsPrefix = false;
const pending = new Set<string>();

async function failureCode(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (error) {
    if (error instanceof FilegateError) return { status: error.status, code: error.code };
    throw new Error("Local Filegate request failed without a structured API error");
  }
}

suite("actual Filegate 6.1.0 transfer contract (isolated local prefix)", () => {
  beforeAll(async () => {
    client = new Filegate({ baseUrl: testInfra.filegate!, token: await localFilegateToken(), fetch: transfer });
    const system = await client.system();
    expect(system.version).toBe("6.1.0");
    root = client.root("cloud");
    await root.mkdir(prefix);
    ownsPrefix = true;
  });
  afterAll(async () => {
    for (const id of pending) await root.abortSession(id).catch(() => {});
    if (ownsFreeipaPrefix) {
      await freeipa.remove(prefix, true);
      expect((await failureCode(() => freeipa.stat(prefix)))?.status).toBe(404);
    }
    if (ownsPrefix) {
      await root.remove(prefix, true);
      expect((await failureCode(() => root.stat(prefix)))?.status).toBe(404);
    }
    // Evidence contains states/status codes only, never credentials or signed URLs.
    console.log("Filegate contract evidence:", JSON.stringify(statuses));
  });

  test("session receipt permits reconciliation after a lost commit response and rejects abort after commit", async () => {
    const path = `${prefix}/session.txt`;
    const key = randomUUID();
    const opened = await root.createSession(path, 3, { onConflict: "error", allowAbort: true, idempotencyKey: key });
    const replay = await root.createSession(path, 3, { onConflict: "error", allowAbort: true, idempotencyKey: key });
    expect(replay.session.id).toBe(opened.session.id);
    expect(replay.lease).toBeDefined();
    pending.add(opened.session.id);
    const initial = await root.session(opened.session.id);
    expect(initial.state).toBe("open");
    expect(Date.parse(initial.expires)).toBeGreaterThan(Date.now());
    expect(initial.result).toBeUndefined();
    await new DirectSession(opened.lease!.url, transfer).upload(new Blob(["abc"]));
    await root.commitSession(opened.session.id); // Intentionally discard this response; status must provide the receipt.
    pending.delete(opened.session.id);
    const terminalReplay = await root.createSession(path, 3, { onConflict: "error", allowAbort: true, idempotencyKey: key });
    expect(terminalReplay.session.id).toBe(opened.session.id);
    expect(terminalReplay.session.state).toBe("committed");
    expect(terminalReplay.lease).toBeUndefined();
    const changed = await failureCode(() => root.createSession(path, 4, { onConflict: "error", allowAbort: true, idempotencyKey: key }));
    expect(changed).toEqual({ status: 409, code: "idempotency_conflict" });
    const committed = await root.session(opened.session.id);
    expect(committed.state).toBe("committed");
    expect(committed.result).toMatchObject({ path, size: 3 });
    expect(Date.parse(committed.terminalAt!)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(committed.retainUntil!)).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60_000);
    const again = await root.commitSession(opened.session.id);
    expect(again).toEqual(committed.result!);
    const abort = await failureCode(() => root.abortSession(opened.session.id));
    statuses.commit = {
      state: committed.state,
      hasResult: !!committed.result,
      hasExpiry: !!committed.expires,
      hasTerminalAt: !!committed.terminalAt,
      hasRetainUntil: !!committed.retainUntil,
      abortAfterCommit: abort,
    };
    expect(abort?.status).toBe(409);
    expect((await root.session(opened.session.id)).state).toBe("committed");
    expect(await (await root.contentRaw(path)).text()).toBe("abc");
  });

  test("abort retains an explicit terminal receipt and cannot be committed", async () => {
    const opened = await root.createSession(`${prefix}/aborted.txt`, 0, { allowAbort: true });
    pending.add(opened.session.id);
    await root.abortSession(opened.session.id);
    pending.delete(opened.session.id);
    const aborted = await root.session(opened.session.id);
    expect(aborted.state).toBe("aborted");
    expect(Date.parse(aborted.retainUntil!)).toBeGreaterThan(Date.now());
    const commit = await failureCode(() => root.commitSession(opened.session.id));
    const abortAgain = await failureCode(() => root.abortSession(opened.session.id));
    statuses.abort = {
      state: aborted.state,
      hasResult: !!aborted.result,
      hasRetainUntil: !!aborted.retainUntil,
      commitAfterAbort: commit,
      repeatAbort: abortAgain,
    };
    expect(commit?.status).toBe(409);
    expect(abortAgain).toBeNull();
    expect((await failureCode(() => root.stat(`${prefix}/aborted.txt`)))?.status).toBe(404);
  });

  test("an expired direct lease does not erase its open session; backend renewal resumes it", async () => {
    const opened = await root.createSession(`${prefix}/renewed.txt`, 0, { expiresIn: 1, allowAbort: true });
    pending.add(opened.session.id);
    const wait = Math.max(0, Date.parse(opened.lease!.expires) - Date.now()) + 1100;
    expect(wait).toBeLessThan(4000);
    await Bun.sleep(wait);
    const expired = await failureCode(() => new DirectSession(opened.lease!.url, transfer).status());
    const open = await root.session(opened.session.id);
    expect(open.state).toBe("open");
    expect(expired?.status).toBe(401);
    const renewed = await root.sessionLease(opened.session.id, { expiresIn: 60, allowAbort: true });
    expect((await new DirectSession(renewed.url, transfer).status()).state).toBe("open");
    statuses.renew = { expiredLease: expired, sessionState: open.state, renewedLease: "open" };
  });

  test("direct PUT checks a target collision at publication; rename has actual filesystem behavior", async () => {
    const path = `${prefix}/collision.txt`;
    const lease = await root.directUpload(path, 3, { onConflict: "error" });
    await root.put(path, new Blob(["old"]), { onConflict: "error" });
    const collision = await failureCode(() => putDirect(lease.url, new Blob(["new"]), { fetch: transfer }));
    expect(collision).toEqual({ status: 409, code: "path_conflict" });
    expect(await (await root.contentRaw(path)).text()).toBe("old");
    let renamedPath: string | null = null;
    const renameFailure = await failureCode(async () => {
      const renamed = await root.put(path, new Blob(["new"]), { onConflict: "rename" });
      renamedPath = renamed.path;
      expect(renamed.path).not.toBe(path);
      expect(renamed.path.startsWith(`${prefix}/`)).toBe(true);
      expect(await (await root.contentRaw(renamed.path)).text()).toBe("new");
    });
    statuses.direct = { collision, renameFailure, renamed: renamedPath !== null };
    // This expectation records the observed 6.1.0 dependency, not a mock that invents atomic rename behavior.
    expect(renameFailure).toBeNull();
  });

  test("compact status separates paginated segment receipts and repeat writes are idempotent", async () => {
    const chunk = new Uint8Array(8 * 1024 * 1024);
    const opened = await root.createSession(`${prefix}/segments.bin`, chunk.byteLength * 2, {
      allowAbort: true,
      idempotencyKey: randomUUID(),
    });
    pending.add(opened.session.id);
    const direct = new DirectSession(opened.lease!.url, transfer);
    await direct.put(1, chunk);
    await direct.put(0, chunk);
    await direct.put(0, chunk);
    const status = await direct.status();
    expect(status.uploadedSegments).toBe(2);
    expect(status.received).toBe(chunk.byteLength * 2);
    expect("segments" in status).toBe(false);
    const first = await direct.segments(-1, 1);
    expect(first.items.map((item) => item.index)).toEqual([0]);
    expect(first.next).toBe(0);
    const second = await direct.segments(first.next, 1);
    expect(second.items.map((item) => item.index)).toEqual([1]);
    expect(second.next).toBeUndefined();
    chunk[0] = 1;
    expect((await failureCode(() => direct.put(0, chunk)))?.status).toBe(409);
    statuses.segments = { count: status.uploadedSegments, pages: 2, compact: !("segments" in status) };
  });

  test("Markdown direct downloads expose the revision of their bytes and stale session publication is rejected", async () => {
    const path = `${prefix}/markdown.md`;
    await root.put(path, new Blob(["old draft"]), { onConflict: "error" });
    const lease = await root.directDownload(path, { expiresIn: 60 });
    const response = await fetch(lease.url, { headers: { Origin: "http://localhost:3000" } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("old draft");
    const etag = response.headers.get("etag")!;
    expect(etag).toMatch(/^"[^"\\]+"$/);
    expect(response.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("etag");
    const opened = await root.createSession(path, 5, { onConflict: "overwrite", precondition: { ifMatch: etag.slice(1, -1) } });
    pending.add(opened.session.id);
    await new DirectSession(opened.lease!.url, transfer).upload(new Blob(["stale"]));
    await root.put(path, new Blob(["newer"]), { onConflict: "overwrite" });
    expect((await failureCode(() => root.commitSession(opened.session.id)))?.status).toBe(412);
    expect(await (await root.contentRaw(path)).text()).toBe("newer");
  });

  test("concurrent managed writers admit exactly one save of the same revision", async () => {
    const path = `${prefix}/parallel.md`;
    const original = await root.put(path, new Blob(["original"]), { onConflict: "error" });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        failureCode(() =>
          root.put(path, new Blob([`writer-${index}`]), { onConflict: "overwrite", precondition: { ifMatch: original.revision! } }),
        ),
      ),
    );
    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect(results.filter((result) => result?.code === "precondition_failed")).toHaveLength(7);
    const winner = results.findIndex((result) => result === null);
    expect(await (await root.contentRaw(path)).text()).toBe(`writer-${winner}`);
    statuses.concurrent = { accepted: 1, conflicts: 7, preservedWinner: true };
  });

  test("managed publication rejects stale revisions before changing content", async () => {
    expect((await root.info()).managed).toBe(true);
    const path = `${prefix}/conditional.txt`;
    await root.put(path, new Blob(["first"]), { precondition: { ifNoneMatch: true } });
    const before = await root.stat(path);
    expect(before.revision).toBeDefined();
    await root.put(path, new Blob(["second"]), { onConflict: "overwrite", precondition: { ifMatch: before.revision! } });
    const conflict = await failureCode(() =>
      root.put(path, new Blob(["stale"]), { onConflict: "overwrite", precondition: { ifMatch: before.revision! } }),
    );
    expect(conflict).toEqual({ status: 412, code: "precondition_failed" });
    expect(await (await root.contentRaw(path)).text()).toBe("second");
    expect((await root.stat(path)).revision).not.toBe(before.revision);
    statuses.managed = { staleRevision: conflict, preservedCurrent: true };
  });

  test("Unix execution denies unreadable leaf content and recursive ZIP at actual transfer", async () => {
    freeipa = client.root("freeipa");
    expect((await freeipa.info()).execution).toBe(true);
    await freeipa.mkdir(prefix, { ownership: { uid: 12345, gid: 12345, dirMode: "0700" } });
    ownsFreeipaPrefix = true;
    await freeipa.put(`${prefix}/visible.txt`, new Blob(["visible"]), { ownership: { uid: 12345, gid: 12345, mode: "0600" } });
    await freeipa.put(`${prefix}/private.txt`, new Blob(["private"]), { ownership: { uid: 23456, gid: 23456, mode: "0600" } });
    const identity = { uid: 12345, gid: 12345, groups: [] };
    const scoped = freeipa.as(identity);
    const visible = await scoped.contentRaw(`${prefix}/visible.txt`);
    expect(visible.status).toBe(200);
    expect(await visible.text()).toBe("visible");
    const denied = await scoped.contentRaw(`${prefix}/private.txt`);
    expect(denied.status).toBe(403);
    await denied.body?.cancel();
    const archive = await client.as(identity).archiveLease([{ root: "freeipa", path: prefix, archivePath: "selection" }]);
    const zipped = await client.archiveRaw(archive);
    expect(zipped.status).toBe(403);
    await zipped.body?.cancel();
    statuses.unix = { readable: visible.status, unreadable: denied.status, recursiveArchive: zipped.status };
  });

  test("directory cursors advance without loss and historical leases read the captured bytes", async () => {
    const folder = `${prefix}/cursor`;
    await root.mkdir(folder);
    for (const name of ["a.txt", "b.txt", "c.txt"]) await root.put(`${folder}/${name}`, new Blob([name]));
    const names: string[] = [];
    let after: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await root.list(folder, { limit: 1, after });
      names.push(...page.items.map((node) => node.path));
      after = page.next;
      if (after) {
        expect(cursors.has(after)).toBe(false);
        cursors.add(after);
      }
    } while (after && cursors.size < 5);
    expect(names).toEqual(["a.txt", "b.txt", "c.txt"].map((name) => `${folder}/${name}`));
    const version = await root.snapshot(`${folder}/a.txt`);
    await root.put(`${folder}/a.txt`, new Blob(["changed"]), { onConflict: "overwrite" });
    const lease = await root.directVersionDownload(`${folder}/a.txt`, version.id, { fileName: "Überblick.txt" });
    const response = await transfer(lease.url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8\'\'%C3%9Cberblick.txt");
    expect(await response.text()).toBe("a.txt");
    statuses.reads = { entries: names.length, cursorPages: cursors.size + 1, historicalLease: response.status };
  });
});

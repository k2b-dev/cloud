import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Filegate, FilegateError, type RootClient } from "@k2b/filegate";
import { DirectSession, putDirect } from "@k2b/filegate/utils";

// Deliberately opt-in and pinned to local development. Never use application fixtures or a remote target.
const enabled = process.env.FILESV2_FILEGATE_CONTRACT === "1";
const prefix = `filesv2-slice-${randomUUID()}`;
const transfer = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, credentials: "omit", signal: AbortSignal.timeout(10_000) }),
  { preconnect: fetch.preconnect },
);
const statuses: Record<string, unknown> = {};
let root: RootClient;
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

(enabled ? describe : describe.skip)("actual Filegate 5.1.0 transfer contract (isolated local prefix)", () => {
  beforeAll(async () => {
    const token = (await Bun.file(resolve(import.meta.dir, "../../../.local/filegate/token")).text()).trim();
    const client = new Filegate({ baseUrl: "http://localhost:4000", token, fetch: transfer });
    const system = await client.system();
    expect(system.version).toBe("5.1.0");
    root = client.root("cloud");
    await root.mkdir(prefix);
    ownsPrefix = true;
  });
  afterAll(async () => {
    for (const id of pending) await root.abortSession(id).catch(() => {});
    if (ownsPrefix) {
      await root.remove(prefix, true);
      expect((await failureCode(() => root.stat(prefix)))?.status).toBe(404);
    }
    // Evidence contains states/status codes only, never credentials or signed URLs.
    console.log("Filegate contract evidence:", JSON.stringify(statuses));
  });

  test("session receipt permits reconciliation after a lost commit response and rejects abort after commit", async () => {
    const path = `${prefix}/session.txt`;
    const opened = await root.createSession(path, 3, { onConflict: "error", allowAbort: true });
    pending.add(opened.session.id);
    const initial = await root.session(opened.session.id);
    expect(initial.state).toBe("open");
    expect(Date.parse(initial.expires)).toBeGreaterThan(Date.now());
    expect(initial.result).toBeUndefined();
    await new DirectSession(opened.lease.url, transfer).upload(new Blob(["abc"]));
    await root.commitSession(opened.session.id); // Intentionally discard this response; status must provide the receipt.
    pending.delete(opened.session.id);
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
    const wait = Math.max(0, Date.parse(opened.lease.expires) - Date.now()) + 1100;
    expect(wait).toBeLessThan(4000);
    await Bun.sleep(wait);
    const expired = await failureCode(() => new DirectSession(opened.lease.url, transfer).status());
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
    expect(collision?.status).toBe(409);
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
    // This expectation records the observed 5.1.0 dependency, not a mock that invents atomic rename behavior.
    expect(renameFailure).toBeNull();
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
    const lease = await root.directVersionDownload(`${folder}/a.txt`, version.id);
    const response = await transfer(lease.url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("a.txt");
    statuses.reads = { entries: names.length, cursorPages: cursors.size + 1, historicalLease: response.status };
  });
});

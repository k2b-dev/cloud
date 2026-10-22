import { afterEach, beforeEach, expect, jest, setSystemTime, test } from "bun:test";
import { REQUEST_IDLE_TIMEOUT_SECONDS, type resolveDisplayNames } from "@k2b/cloud/server";
import { testActor, testCall } from "../../test/files-call";
import { ACTIVITY_EXPORT_BATCH, ActivityExportInput, csvCell, type ExportRow, exportWindow } from "../activity-export-contracts";
import { type ActivityExportDeps, type ActivityExportSnapshot, createActivityExportService } from "./activity-export";
import { FilesError } from "./errors";

const now = new Date("2030-05-15T12:00:00.000Z");
const input: ActivityExportInput = { format: "jsonl", from: "2030-01-01", to: "2030-12-31" };
const call = { ...testCall(testActor), requestId: "original-request" };
beforeEach(() => setSystemTime(now));
afterEach(() => {
  jest.useRealTimers();
  setSystemTime();
});
const row = (index = 1): ExportRow => ({
  id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  action: "item.move",
  state: "done",
  time: "2030-05-15 12:00:00.000001+00",
  startedAt: now,
  finishedAt: now,
  actorKind: "user",
  actorUserId: "10000000-0000-4000-8000-000000000001",
  via: "web",
  directory: false,
  rootBefore: "cloud",
  baseBeforeId: null,
  pathBefore: "old/Grüße.txt",
  itemBeforeId: "file-id",
  rootAfter: "cloud",
  baseAfterId: null,
  pathAfter: "new/Grüße.txt",
  itemAfterId: "file-id",
  batchId: null,
});
function fixture(size = 1) {
  const events: string[] = [];
  let offset = 0;
  let closed = 0;
  let batches = 0;
  let authorization = 0;
  let evidence = 0;
  let snapshotSignal: AbortSignal | undefined;
  const snapshot: ActivityExportSnapshot = {
    async count() {
      events.push("count");
      return size;
    },
    async batch(after) {
      events.push("batch");
      batches++;
      if (after) expect(after.time).toBe("2030-05-15 12:00:00.000001+00");
      const result = Array.from({ length: Math.min(ACTIVITY_EXPORT_BATCH, size - offset) }, (_, index) => row(offset + index + 1));
      offset += result.length;
      return result;
    },
    async close() {
      events.push("close");
      closed++;
    },
  };
  const displayNames: typeof resolveDisplayNames = async (entries) => entries.map((entry) => ({ ...entry, displayName: "Alice live" }));
  const deps: ActivityExportDeps = {
    async requireAdmin(actor) {
      expect(actor).toBe(call.actor);
      events.push("admin");
      authorization++;
    },
    displayNames,
    async snapshot(_filter, signal) {
      events.push("snapshot");
      snapshotSignal = signal;
      return snapshot;
    },
    async recordStart(original, filters, count) {
      expect(original).toBe(call);
      expect(filters).toEqual(input);
      expect(count).toBe(size);
      events.push("audit-commit");
      evidence++;
    },
  };
  return {
    deps,
    snapshot,
    events,
    service: () => createActivityExportService(deps),
    get closed() {
      return closed;
    },
    get batches() {
      return batches;
    },
    get evidence() {
      return evidence;
    },
    get authorization() {
      return authorization;
    },
    get signal() {
      return snapshotSignal;
    },
  };
}
const decode = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

test("inclusive UTC window accepts a leap calendar year and rejects an extra day, invalid dates, reverse ranges", () => {
  expect(exportWindow({ ...input, from: "2024-01-01", to: "2024-12-31" })).toEqual({
    from: "2024-01-01T00:00:00.000Z",
    until: "2025-01-01T00:00:00.000Z",
  });
  expect(() => exportWindow({ ...input, from: "2024-01-01", to: "2025-01-01" })).toThrow("activity_export_range");
  expect(() => exportWindow({ ...input, from: "2030-06-01", to: "2030-05-01" })).toThrow("activity_export_range");
  expect(ActivityExportInput.safeParse({ ...input, from: "2030-02-29" }).success).toBe(false);
  expect(exportWindow({ ...input, from: "2024-02-29", to: "2025-02-27" }).until).toBe("2025-02-28T00:00:00.000Z");
  expect(() => exportWindow({ ...input, from: "2024-02-29", to: "2025-02-28" })).toThrow("activity_export_range");
});

test.each(["=1+1", "+cmd", "-1", "@SUM(A1)", " \t\r\n=bad", "\0\x01+bad", "\u200b@bad"])("CSV prevents spreadsheet formula %j", (value) => {
  expect(csvCell(value).startsWith("\"'")).toBe(true);
});
test("CSV quotes Unicode, commas, quotes and embedded newlines without altering safe text", () => {
  expect(csvCell('Grüße, "Welt"\n第二行')).toBe('"Grüße, ""Welt""\n第二行"');
  expect(csvCell(null)).toBe('""');
  expect(csvCell(false)).toBe('"false"');
});

test("current admin denial happens before opening SQL/history or audit", async () => {
  const f = fixture();
  f.deps.requireAdmin = async () => {
    throw new FilesError("forbidden", 403);
  };
  await expect(f.service().export(call, input, new AbortController().signal)).rejects.toMatchObject({ code: "forbidden" });
  expect(f.events).toEqual([]);
});
test("100001 rows denies before bytes, batch reads or audit; count snapshot closes", async () => {
  const f = fixture(100001);
  await expect(f.service().export(call, input, new AbortController().signal)).rejects.toMatchObject({
    code: "activity_export_limit",
    status: 413,
  });
  expect(f.events).toEqual(["admin", "snapshot", "count", "close"]);
  expect(f.closed).toBe(1);
});
test("count failure releases the snapshot without an audit or a stream", async () => {
  const f = fixture();
  f.snapshot.count = async () => {
    throw new Error("query failed");
  };
  await expect(f.service().export(call, input, new AbortController().signal)).rejects.toThrow("query failed");
  expect(f.closed).toBe(1);
  expect(f.evidence).toBe(0);
  expect(f.batches).toBe(0);
});
test("audit rollback denies before a response or any batch and releases the snapshot", async () => {
  const f = fixture();
  f.deps.recordStart = async () => {
    throw new Error("audit rolled back");
  };
  await expect(f.service().export(call, input, new AbortController().signal)).rejects.toThrow("audit rolled back");
  expect(f.closed).toBe(1);
  expect(f.evidence).toBe(0);
  expect(f.batches).toBe(0);
});
test("revocation while preparing denies response even after the committed start audit", async () => {
  const f = fixture();
  f.deps.recordStart = async () => {
    f.deps.requireAdmin = async () => {
      throw new FilesError("forbidden", 403);
    };
  };
  await expect(f.service().export(call, input, new AbortController().signal)).rejects.toMatchObject({ code: "forbidden" });
  expect(f.closed).toBe(1);
  expect(f.batches).toBe(0);
});
test("revocation between prepare and first pull denies CSV header too", async () => {
  const f = fixture(0);
  f.deps.recordStart = async () => undefined;
  const result = await f.service().export(call, { ...input, format: "csv" }, new AbortController().signal);
  f.deps.requireAdmin = async () => {
    throw new FilesError("forbidden", 403);
  };
  await expect(result.stream.getReader().read()).rejects.toMatchObject({ code: "activity_export_failed" });
  expect(f.closed).toBe(1);
});
test.each(["csv", "jsonl"] as const)("zero-row %s commits evidence before even the header and needs no batch", async (format) => {
  const f = fixture(0);
  f.deps.recordStart = async () => {
    f.events.push("audit-commit");
  };
  const result = await f.service().export(call, { ...input, format }, new AbortController().signal);
  expect(f.events).toEqual(["admin", "snapshot", "count", "admin", "audit-commit", "admin"]);
  const text = await new Response(result.stream).text();
  expect(format === "csv" ? text.startsWith('"id","action"') : text === "").toBe(true);
  if (format === "csv") expect(text.split("\r\n")).toHaveLength(2);
  expect(f.batches).toBe(0);
  expect(f.closed).toBe(1);
});
test("100000 rows stream with bounded demand-driven batches, exact counters, no frames", async () => {
  const f = fixture(100000);
  const result = await f.service().export(call, input, new AbortController().signal);
  expect(result.count).toBe(100000);
  expect(f.evidence).toBe(1);
  expect(f.batches).toBe(0);
  const reader = result.stream.getReader();
  let lines = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const batch = decode(chunk.value).trimEnd().split("\n");
    expect(batch.length).toBeLessThanOrEqual(ACTIVITY_EXPORT_BATCH);
    lines += batch.length;
    expect(JSON.parse(batch[0]!).actorName).toBe("Alice live");
  }
  expect(lines).toBe(100000);
  expect(f.batches).toBe(200);
  expect(f.closed).toBe(1);
});
test("JSONL escapes newlines and drops all extra fields; deleted actors never receive a name", async () => {
  const f = fixture(1);
  f.snapshot.batch = async () => [
    { ...row(), actorUserId: null, pathAfter: 'Grüße\n"第二行"', detail: { token: "secret" }, server_url: "private" },
  ];
  const result = await f.service().export(call, input, new AbortController().signal);
  const text = await new Response(result.stream).text();
  expect(text.split("\n")).toHaveLength(2);
  expect(JSON.parse(text)).toMatchObject({ actorUserId: null, actorName: null, pathAfter: 'Grüße\n"第二行"', time: now.toISOString() });
  expect(text).not.toContain("secret");
  expect(text).not.toContain("private");
  expect(text).not.toContain("detail");
});
test("streamed CSV applies formula protection and RFC quoting to paths and live actor names", async () => {
  const f = fixture(1);
  f.deps.recordStart = async () => undefined;
  f.snapshot.batch = async () => [{ ...row(), pathAfter: '\t\n=SUM(1,2) "Grüße"' }];
  f.deps.displayNames = async (entries) => entries.map((entry) => ({ ...entry, displayName: " @danger" }));
  const result = await f.service().export(call, { ...input, format: "csv" }, new AbortController().signal);
  const text = await new Response(result.stream).text();
  expect(text).toContain('"\'\t\n=SUM(1,2) ""Grüße"""');
  expect(text).toContain('"\' @danger"');
  expect(f.closed).toBe(1);
});
test.each(["early", "midstream"])(
  "reader cancellation %s closes snapshot, preserves committed evidence and fetches only demanded batches",
  async (phase) => {
    const f = fixture(1000);
    const result = await f.service().export(call, input, new AbortController().signal);
    const reader = result.stream.getReader();
    if (phase === "midstream") expect((await reader.read()).done).toBe(false);
    expect(f.batches).toBe(phase === "early" ? 0 : 1);
    await reader.cancel();
    expect(f.closed).toBe(1);
    expect(f.evidence).toBe(1);
    expect(f.signal?.aborted).toBe(true);
  },
);
test("request abort during a pending batch rejects the reader and releases the DB", async () => {
  const f = fixture(1000);
  const signal = new AbortController();
  const started = Promise.withResolvers<void>();
  f.snapshot.batch = async () => {
    started.resolve();
    return new Promise(() => undefined);
  };
  const result = await f.service().export(call, input, signal.signal);
  const read = result.stream.getReader().read();
  await started.promise;
  signal.abort();
  await expect(read).rejects.toMatchObject({ code: "activity_export_failed" });
  expect(f.closed).toBe(1);
  expect(f.evidence).toBe(1);
});
test("abort before authorization reads nothing; a late opening after abort closes too", async () => {
  const f = fixture();
  const aborted = new AbortController();
  aborted.abort();
  await expect(f.service().export(call, input, aborted.signal)).rejects.toHaveProperty("name", "AbortError");
  expect(f.events).toEqual([]);
  const opening = Promise.withResolvers<ActivityExportSnapshot>();
  const started = Promise.withResolvers<void>();
  f.deps.snapshot = async () => {
    started.resolve();
    return opening.promise;
  };
  const request = new AbortController();
  const result = f.service().export(call, input, request.signal);
  await started.promise;
  request.abort();
  await expect(result).rejects.toHaveProperty("name", "AbortError");
  opening.resolve(f.snapshot);
  await Promise.resolve();
  await Promise.resolve();
  expect(f.closed).toBe(1);
});
test("unread streams time out using the server idle budget and release their snapshot", async () => {
  jest.useFakeTimers();
  const f = fixture();
  const result = await f.service().export(call, input, new AbortController().signal);
  jest.advanceTimersByTime(REQUEST_IDLE_TIMEOUT_SECONDS * 1000);
  await expect(result.stream.getReader().read()).rejects.toMatchObject({ code: "activity_export_failed" });
  expect(f.closed).toBe(1);
  expect(f.batches).toBe(0);
});
test("abort exactly when snapshot opening resolves cannot miss ownership or start a count", async () => {
  const f = fixture();
  const request = new AbortController();
  const opened = Promise.withResolvers<ActivityExportSnapshot>();
  f.deps.snapshot = async () => opened.promise;
  const result = f.service().export(call, input, request.signal);
  // Let authorization finish, then place the abort beside the opening continuation.
  await Promise.resolve();
  await Promise.resolve();
  opened.resolve(f.snapshot);
  queueMicrotask(() => request.abort());
  await expect(result).rejects.toHaveProperty("name", "AbortError");
  await Promise.resolve();
  await Promise.resolve();
  expect(f.closed).toBe(1);
  expect(f.events).not.toContain("count");
});
test("oversized or failed batches surface a stream error, without output, and release the snapshot", async () => {
  for (const failure of ["oversize", "exception"]) {
    const f = fixture(1000);
    f.snapshot.batch = async () => {
      if (failure === "exception") throw new Error("opaque database failure with credentials");
      return Array.from({ length: 501 }, (_, index) => row(index + 1));
    };
    const result = await f.service().export(call, input, new AbortController().signal);
    await expect(result.stream.getReader().read()).rejects.toMatchObject({ code: "activity_export_failed" });
    expect(f.closed).toBe(1);
  }
});
test("final snapshot close failure still errors the reader instead of hanging in a closed cleanup state", async () => {
  const f = fixture(0);
  f.snapshot.close = async () => {
    throw new Error("connection lost on commit");
  };
  const result = await f.service().export(call, input, new AbortController().signal);
  await expect(result.stream.getReader().read()).rejects.toMatchObject({ code: "activity_export_failed" });
});
test("aborting while audit is pending signals its owner and denies the export before any response", async () => {
  const f = fixture();
  const request = new AbortController();
  const started = Promise.withResolvers<void>();
  let cancelled = false;
  f.deps.recordStart = async (_call, _input, _count, signal) => {
    started.resolve();
    return new Promise((_resolve, reject) =>
      signal.addEventListener(
        "abort",
        () => {
          cancelled = true;
          reject(signal.reason);
        },
        { once: true },
      ),
    );
  };
  const preparing = f.service().export(call, input, request.signal);
  await started.promise;
  request.abort();
  await expect(preparing).rejects.toHaveProperty("name", "AbortError");
  expect(cancelled).toBe(true);
  expect(f.closed).toBe(1);
  expect(f.batches).toBe(0);
});

test("preview rechecks rights after counting and releases the snapshot without audit or bytes", async () => {
  const f = fixture(8412);
  expect(await f.service().preview(call, input, new AbortController().signal)).toEqual({ count: 8412 });
  expect(f.events).toEqual(["admin", "snapshot", "count", "admin", "close"]);
  expect(f.evidence).toBe(0);
  expect(f.batches).toBe(0);
});
test("preview cancellation closes a late-arriving snapshot and never reads or audits it", async () => {
  const f = fixture();
  const request = new AbortController();
  const opening = Promise.withResolvers<ActivityExportSnapshot>();
  const started = Promise.withResolvers<void>();
  f.deps.snapshot = async () => {
    started.resolve();
    return opening.promise;
  };
  const result = f.service().preview(call, input, request.signal);
  const outcome = result.then(
    () => null,
    (error: unknown) => error,
  );
  await started.promise;
  request.abort();
  expect(await outcome).toBeInstanceOf(DOMException);
  opening.resolve(f.snapshot);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(f.closed).toBe(1);
  expect(f.evidence).toBe(0);
  expect(f.batches).toBe(0);
});

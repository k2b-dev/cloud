import {
  REQUEST_IDLE_TIMEOUT_MAX_SECONDS,
  REQUEST_IDLE_TIMEOUT_SECONDS,
  type RequestActor,
  type resolveDisplayNames,
} from "@k2b/cloud/server";
import { audit, logger } from "@k2b/cloud/services";
import { SQL, sql } from "bun";
import {
  ACTIVITY_EXPORT_BATCH,
  ACTIVITY_EXPORT_LIMIT,
  ActivityExportError,
  ActivityExportInput,
  csvCell,
  EXPORT_COLUMNS,
  ExportAction,
  ExportRow,
  exportWindow,
} from "../activity-export-contracts";
import type { UserFilesCall } from "./activity";
import { withActivityReadBudget } from "./activity-read-budget";
import { FilesError } from "./errors";

type Filter = ActivityExportInput & ReturnType<typeof exportWindow>;
type Position = { time: string; id: string };
export interface ActivityExportSnapshot {
  count(): Promise<number>;
  batch(after: Position | null): Promise<ExportRow[]>;
  close(): Promise<void>;
}
export type ActivityExportDeps = {
  /** Must resolve current canonical administration rights, never actor.roles from the request. */
  requireAdmin(actor: RequestActor): Promise<unknown>;
  displayNames: typeof resolveDisplayNames;
  snapshot?: (filter: Filter, signal: AbortSignal) => Promise<ActivityExportSnapshot>;
  recordStart?: (call: UserFilesCall, input: ActivityExportInput, count: number, signal: AbortSignal) => Promise<void>;
};
const log = logger("filesv2:activity-export");

/** Hold the backend until cancellation finishes; a late cancel must never hit the next pool user. */
async function reserveExportConnection(database: SQL, signal: AbortSignal) {
  const connection = await database.reserve({ signal });
  let backendPid: number | undefined;
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= (async () => {
      try {
        if (backendPid !== undefined) {
          // Bun 1.4.2 query.cancel() does not interrupt PostgreSQL. Use a separate connection,
          // so cancellation cannot queue behind blocked exports in the application pool.
          const control = new SQL({ ...database.options, max: 1 });
          try {
            await withActivityReadBudget(undefined, (budget) =>
              budget.run(
                () => control`SELECT pg_cancel_backend(${backendPid})`,
                () => {
                  void control.close({ timeout: 0 }).catch(() => undefined);
                },
              ),
            );
          } finally {
            await control.close({ timeout: 0 });
          }
        }
      } finally {
        // Also covers abort during connection initialization and socket/protocol failures.
        await connection.close({ timeout: 0 });
      }
    })().catch(() => log.error("Export SQL cancellation failed", { code: "activity_export_failed" }));
    return cancellation;
  };
  const abort = () => void cancel();
  signal.addEventListener("abort", abort, { once: true });
  const close = async () => {
    signal.removeEventListener("abort", abort);
    try {
      await cancellation;
    } finally {
      connection.release();
    }
  };
  try {
    signal.throwIfAborted();
    const [backend] = await connection<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    if (!backend) throw new Error("Missing export backend");
    backendPid = backend.pid;
    signal.throwIfAborted();
    return { connection, cancel, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** One callback owns the repeatable-read connection until close; no domain writes occur here. */
export async function openActivityExportSnapshot(
  filter: Filter,
  signal: AbortSignal,
  database: SQL = sql,
): Promise<ActivityExportSnapshot> {
  const owner = await reserveExportConnection(database, signal);
  const ready = Promise.withResolvers<ActivityExportSnapshot>();
  const release = Promise.withResolvers<void>();
  let active: Promise<unknown> | undefined;
  let closing = false;
  let closeTask: Promise<void> | undefined;
  let finished: Promise<unknown>;
  const abort = () => {
    release.resolve();
    ready.reject(signal.reason);
  };
  signal.addEventListener("abort", abort, { once: true });
  // Bun accepts SQL options as a string, also used by Chat's snapshot readers.
  const transaction = owner.connection.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (tx) => {
    async function run<T>(query: Promise<T>): Promise<T> {
      signal.throwIfAborted();
      if (closing) throw new DOMException("Export closed", "AbortError");
      const settled = Promise.resolve(query);
      active = settled;
      try {
        return await settled;
      } finally {
        active = undefined;
      }
    }
    try {
      signal.throwIfAborted();
      // Server-side protection supplements request cancellation, including a consumer that never reads.
      await run(tx`SELECT set_config('statement_timeout', ${String(REQUEST_IDLE_TIMEOUT_MAX_SECONDS * 1000)}, true),
        set_config('idle_in_transaction_session_timeout', ${String(REQUEST_IDLE_TIMEOUT_MAX_SECONDS * 1000)}, true)`);
      // A fragment is never executed by itself. Bun registers tx-tagged fragments as
      // pending transaction queries and rejects them without a handler on hard close.
      // Build through the same adapter's pool; count/batch still execute it only on tx.
      // The same local-area boundary applies to the export count, search and bytes.
      // Redact the POSIX side of a cross-area copy independently of its visible side.
      const visibleSide = (after: boolean) => {
        const id = after
          ? database`coalesce(event.base_after_id,CASE WHEN coalesce(event.root_after,event.root)=event.root THEN event.base_id END)`
          : database`event.base_id`;
        const root = after ? database`coalesce(event.root_after,event.root)` : database`event.root`;
        const path = after ? database`event.path_after` : database`event.path_before`;
        return database`EXISTS (SELECT 1 FROM filesv2.bases b WHERE b.id=${id} AND b.area='cloud'
          AND b.root=${root} AND ${path} IS NOT NULL AND (${path}=b.path OR starts_with(${path},b.path || '/')))`;
      };
      const source = database`(SELECT event.*,${visibleSide(false)} AS before_visible,${visibleSide(true)} AS after_visible FROM filesv2.activity event) a`;
      const where = database`(a.before_visible OR a.after_visible)
        AND coalesce(a.finished_at,a.started_at)>=${filter.from}::timestamptz
        AND coalesce(a.finished_at,a.started_at)<${filter.until}::timestamptz
        AND a.action=ANY(${tx.array(ExportAction.options, "TEXT")})
        AND (${filter.q ?? null}::text IS NULL OR (a.before_visible AND strpos(lower(coalesce(a.path_before,'')),lower(${filter.q ?? null}))>0)
          OR (a.after_visible AND strpos(lower(coalesce(a.path_after,'')),lower(${filter.q ?? null}))>0))
        AND (${filter.actor ?? null}::uuid IS NULL OR a.actor_user_id=${filter.actor ?? null}::uuid)
        AND (${filter.action ?? null}::text IS NULL OR a.action=${filter.action ?? null})
        AND (${filter.baseId ?? null}::text IS NULL OR EXISTS (
          SELECT 1 FROM filesv2.bases b WHERE b.area||':'||b.kind||':'||b.identity_id::text=${filter.baseId ?? null}
          AND ((a.before_visible AND b.id=a.base_id) OR (a.after_visible AND b.id=coalesce(a.base_after_id,CASE WHEN coalesce(a.root_after,a.root)=a.root THEN a.base_id END)))
        ))`;
      ready.resolve({
        async count() {
          const [row] = await run(tx<{ count: number }[]>`SELECT count(*)::int AS count FROM (
            SELECT 1 FROM ${source} WHERE ${where} LIMIT ${ACTIVITY_EXPORT_LIMIT + 1}
          ) bounded`);
          if (!row) throw new Error("Missing export count");
          return row.count;
        },
        async batch(after) {
          // A nullable OR prevents generic prepared plans from using the keyset as
          // an index condition. Keep the first page and subsequent pages distinct.
          const position = after
            ? database`(coalesce(a.finished_at,a.started_at),a.id)>(${after.time}::timestamptz,${after.id}::uuid)`
            : database`TRUE`;
          return run(tx<ExportRow[]>`SELECT a.id,a.action,a.state,coalesce(a.finished_at,a.started_at)::text AS time,
            a.started_at AS "startedAt",a.finished_at AS "finishedAt",a.actor_kind AS "actorKind",a.actor_user_id AS "actorUserId",
            a.via,CASE WHEN metadata.known THEN a.directory END AS directory,a.batch_id AS "batchId",
            CASE WHEN metadata.known AND a.before_visible THEN a.root END AS "rootBefore",
            CASE WHEN metadata.known AND a.before_visible THEN a.base_id END AS "baseBeforeId",CASE WHEN a.before_visible THEN a.path_before END AS "pathBefore",
            CASE WHEN metadata.known AND a.before_visible THEN a.item_id END AS "itemBeforeId",
            CASE WHEN metadata.known AND a.after_visible THEN coalesce(a.root_after,a.root) END AS "rootAfter",
            CASE WHEN metadata.known AND a.after_visible THEN coalesce(a.base_after_id,CASE WHEN coalesce(a.root_after,a.root)=a.root THEN a.base_id END) END AS "baseAfterId",
            CASE WHEN a.after_visible THEN a.path_after END AS "pathAfter",CASE WHEN metadata.known AND a.after_visible THEN a.item_after_id END AS "itemAfterId"
            FROM ${source} CROSS JOIN LATERAL (
              SELECT NOT (a.detail @> '{"metadata_unknown":true}'::jsonb OR a.detail @> '{"snapshot_unknown":true}'::jsonb
                OR a.detail @> '{"directory_unknown":true}'::jsonb) AS known
            ) metadata WHERE ${where}
              AND ${position}
            ORDER BY coalesce(a.finished_at,a.started_at),a.id LIMIT ${ACTIVITY_EXPORT_BATCH}`);
        },
        async close() {
          closeTask ??= (async () => {
            closing = true;
            const interrupted = active !== undefined;
            if (interrupted) await owner.cancel();
            release.resolve();
            await finished.catch((error: unknown) => {
              if (!signal.aborted && !interrupted) throw error;
            });
          })();
          await closeTask;
        },
      });
      await release.promise;
      await active?.catch(() => undefined);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  });
  finished = transaction.finally(() => owner.close());
  // Attach immediately: transaction errors must never become unhandled background rejections.
  void finished.catch((error: unknown) => ready.reject(error)).finally(() => signal.removeEventListener("abort", abort));
  if (signal.aborted) abort();
  try {
    return await ready.promise;
  } catch (error) {
    await finished.catch(() => undefined);
    throw error;
  }
}

async function recordStart(call: UserFilesCall, input: ActivityExportInput, count: number, signal: AbortSignal): Promise<void> {
  const user = call.actor.kind === "user" ? call.actor.user : call.actor.delegatedUser;
  // The default pool connection is separate from the read-only snapshot. Await its COMMIT before returning a stream.
  const owner = await reserveExportConnection(sql, signal);
  try {
    await owner.connection.begin(async (database) => {
      signal.throwIfAborted();
      await database`SELECT set_config('statement_timeout', ${String(REQUEST_IDLE_TIMEOUT_MAX_SECONDS * 1000)}, true)`;
      await audit.record(
        {
          action: "filesv2.activity.export",
          outcome: "allowed",
          actor: user ? { userId: user.id, uid: user.uid, provider: user.provider, roles: user.roles } : null,
          requestId: call.requestId,
          metadata: {
            phase: "authorized_export_start",
            format: input.format,
            from: input.from,
            to: input.to,
            baseId: input.baseId ?? null,
            actor: input.actor ?? null,
            action: input.action ?? null,
            q: input.q ?? null,
            count,
            invocationId: call.invocationId,
            callingApp: call.callingApp,
            actorKind: call.actor.kind,
            serviceAccountId: call.actor.kind === "service_account" ? call.actor.serviceAccount.id : null,
          },
        },
        database,
      );
      signal.throwIfAborted();
    });
  } finally {
    await owner.close();
  }
}

export function createActivityExportService(deps: ActivityExportDeps) {
  return {
    /** A fresh estimate for the dialog; downloading always recounts and audits its own snapshot. */
    async preview(call: UserFilesCall, rawInput: ActivityExportInput, requestSignal: AbortSignal): Promise<{ count: number }> {
      const input = ActivityExportInput.parse(rawInput);
      const filter = { ...input, ...exportWindow(input) };
      const lifetime = new AbortController();
      const signal = AbortSignal.any([requestSignal, lifetime.signal]);
      const stopped = Promise.withResolvers<never>();
      void stopped.promise.catch(() => undefined);
      const abort = () => stopped.reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(
        () => lifetime.abort(new DOMException("Export preview timed out", "TimeoutError")),
        REQUEST_IDLE_TIMEOUT_MAX_SECONDS * 1000,
      );
      timer.unref();
      let closed = false;
      let snapshot: ActivityExportSnapshot | undefined;
      const wait = <T>(promise: Promise<T>) => Promise.race([promise, stopped.promise]);
      try {
        signal.throwIfAborted();
        await wait(deps.requireAdmin(call.actor));
        if (input.baseId?.startsWith("freeipa:")) throw new FilesError("history_unavailable", 409);
        await wait(
          (deps.snapshot ?? openActivityExportSnapshot)(filter, signal).then(async (value) => {
            if (closed) await value.close();
            else snapshot = value;
          }),
        );
        signal.throwIfAborted();
        if (!snapshot) throw new ActivityExportError("activity_export_failed", 503);
        const count = await wait(snapshot.count());
        if (!Number.isSafeInteger(count) || count < 0) throw new ActivityExportError("activity_export_failed", 503);
        if (count > ACTIVITY_EXPORT_LIMIT) throw new ActivityExportError("activity_export_limit", 413);
        await wait(deps.requireAdmin(call.actor));
        signal.throwIfAborted();
        return { count };
      } finally {
        closed = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        try {
          await snapshot?.close();
        } finally {
          lifetime.abort(new DOMException("Export preview closed", "AbortError"));
        }
      }
    },
    async export(
      call: UserFilesCall,
      rawInput: ActivityExportInput,
      requestSignal: AbortSignal,
    ): Promise<{
      stream: ReadableStream<Uint8Array>;
      count: number;
      format: ActivityExportInput["format"];
    }> {
      const input = ActivityExportInput.parse(rawInput);
      const filter = { ...input, ...exportWindow(input) };
      const lifetime = new AbortController();
      const stopped = Promise.withResolvers<never>();
      // Consume rejection even when abort happens between awaited operations.
      void stopped.promise.catch(() => undefined);
      let snapshot: ActivityExportSnapshot | undefined;
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let closed = false;
      let cleanupTask: Promise<void> | undefined;
      let auditTask: Promise<void> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): Promise<void> => {
        if (cleanupTask) return cleanupTask;
        closed = true;
        clearTimeout(timer);
        requestSignal.removeEventListener("abort", onAbort);
        cleanupTask = snapshot?.close() ?? Promise.resolve();
        return cleanupTask;
      };
      const fail = (reason: unknown) => {
        if (closed) return;
        lifetime.abort(reason);
        stopped.reject(reason);
        controller?.error(new ActivityExportError("activity_export_failed", 503));
        void cleanup().catch(() => log.error("Export snapshot cleanup failed", { code: "activity_export_failed" }));
      };
      const onAbort = () => fail(new DOMException("Export cancelled", "AbortError"));
      const arm = (seconds: number) => {
        clearTimeout(timer);
        timer = setTimeout(() => fail(new DOMException("Export timed out", "TimeoutError")), seconds * 1000);
        timer.unref();
      };
      const wait = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, stopped.promise]);
      requestSignal.addEventListener("abort", onAbort, { once: true });
      arm(REQUEST_IDLE_TIMEOUT_MAX_SECONDS);
      if (requestSignal.aborted) onAbort();
      try {
        lifetime.signal.throwIfAborted();
        await wait(deps.requireAdmin(call.actor)); // Before SQL or history reads, including injected stores.
        if (input.baseId?.startsWith("freeipa:")) throw new FilesError("history_unavailable", 409);
        const opening = (deps.snapshot ?? openActivityExportSnapshot)(filter, lifetime.signal).then(async (value) => {
          // Publish ownership before resuming prepare, so cancellation at this boundary cannot miss the connection.
          snapshot = value;
          if (closed) await value.close().catch(() => log.error("Export snapshot cleanup failed", { code: "activity_export_failed" }));
          return value;
        });
        await wait(opening);
        lifetime.signal.throwIfAborted();
        if (!snapshot) throw new ActivityExportError("activity_export_failed", 503);
        const count = await wait(snapshot.count());
        if (!Number.isSafeInteger(count) || count < 0) throw new ActivityExportError("activity_export_failed", 503);
        if (count > ACTIVITY_EXPORT_LIMIT) throw new ActivityExportError("activity_export_limit", 413);
        await wait(deps.requireAdmin(call.actor));
        auditTask = (deps.recordStart ?? recordStart)(call, input, count, lifetime.signal);
        await wait(auditTask);
        await wait(deps.requireAdmin(call.actor)); // Revocation during count/audit denies the response.
        lifetime.signal.throwIfAborted();
        const current = snapshot;
        let position: Position | null = null;
        let emitted = 0;
        let header = input.format === "csv";
        const encoder = new TextEncoder();
        arm(REQUEST_IDLE_TIMEOUT_SECONDS);
        const stream = new ReadableStream<Uint8Array>(
          {
            start(value) {
              controller = value;
            },
            async pull(value) {
              if (closed) return;
              arm(REQUEST_IDLE_TIMEOUT_SECONDS);
              try {
                // The first pull can be delayed after prepare; recheck the live account again before any bytes.
                if (emitted === 0 && (header || position === null)) await wait(deps.requireAdmin(call.actor));
                if (header) {
                  header = false;
                  value.enqueue(encoder.encode(`${EXPORT_COLUMNS.map(csvCell).join(",")}\r\n`));
                  return;
                }
                if (emitted === count) {
                  await cleanup();
                  value.close();
                  return;
                }
                const rows = await wait(current.batch(position));
                if (!rows.length || rows.length > ACTIVITY_EXPORT_BATCH || emitted + rows.length > count)
                  throw new Error("Export snapshot count mismatch");
                const ids = [...new Set(rows.flatMap((row) => (row.actorUserId ? [row.actorUserId] : [])))];
                const names = await wait(deps.displayNames(ids.map((userId) => ({ principal: { type: "user" as const, userId } }))));
                const byId = new Map(
                  names.flatMap((row) => (row.principal.type === "user" ? [[row.principal.userId, row.displayName ?? null] as const] : [])),
                );
                const lines = rows.map((raw) => {
                  const row = ExportRow.parse(raw); // Explicit schema strips any extra fields, also on injected stores.
                  return {
                    ...row,
                    time: new Date(row.time).toISOString(),
                    actorName: row.actorUserId ? (byId.get(row.actorUserId) ?? null) : null,
                  };
                });
                lifetime.signal.throwIfAborted();
                const last = rows.at(-1)!;
                position = { time: last.time, id: last.id }; // Keep PostgreSQL microseconds for the keyset.
                emitted += rows.length;
                value.enqueue(
                  encoder.encode(
                    lines
                      .map((row) =>
                        input.format === "jsonl"
                          ? `${JSON.stringify(row)}\n`
                          : `${EXPORT_COLUMNS.map((key) => csvCell(row[key])).join(",")}\r\n`,
                      )
                      .join(""),
                  ),
                );
                if (emitted === count) {
                  await cleanup();
                  value.close();
                }
              } catch {
                log.error("History export stream failed", { code: "activity_export_failed" });
                // cleanup may already have marked the source closed before its SQL promise failed.
                value.error(new ActivityExportError("activity_export_failed", 503));
                fail(new ActivityExportError("activity_export_failed", 503));
              }
            },
            async cancel() {
              lifetime.abort(new DOMException("Export cancelled", "AbortError"));
              stopped.reject(lifetime.signal.reason);
              await cleanup();
            },
          },
          { highWaterMark: 0 },
        ); // Never fetch a batch until the consumer asks for it.
        return { stream, count, format: input.format };
      } catch (error) {
        await cleanup().catch(() => log.error("Export snapshot cleanup failed", { code: "activity_export_failed" }));
        lifetime.abort(error);
        await auditTask?.catch(() => undefined);
        throw error;
      }
    },
  };
}

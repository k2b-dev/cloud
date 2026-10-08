import { aiConversations } from "@k2b/cloud/ai";
import { CodeCheckInput } from "@k2b/cloud/ai/browser";
import { sql } from "bun";
import { z } from "zod";
import { ArtifactSource, hasInterface, LIMITS } from "../contracts";
import { artifactDatabase } from "../database";
import { databaseConfigLock } from "../database-lock";
import { CloudError } from "../runtime/errors";
import { ArtifactError, type ArtifactIdentity, artifacts, readArtifactRevision, requireArtifact, user } from "../service";
import { CHECK_LIMITS, CheckReport, checkGate, checkHash, readCheckSteps } from "./check-contracts";

// Allow current and preceding checked revisions for as many apps as the
// host runtime's retained-run budget. One-off hashes share this window.
const CHECK_HISTORY = 2 * LIMITS.pendingRequests;
// Budget two view scopes per retained-run slot in one cleanup transaction.
// Repeated check starts/sweeps drain larger backlogs without unbounded work.
const CHECK_CLEANUP_BATCH = 2 * LIMITS.pendingRequests;

async function chat(id: string, identity: ArtifactIdentity) {
  const conversation = await aiConversations.getConversation({ conversationId: z.uuid().parse(id), ownerUserId: user(identity).id });
  if (!conversation || conversation.archivedAt || (conversation.allowedTools && !conversation.allowedTools.includes("code_check")))
    throw new ArtifactError("ACCESS_DENIED");
  return conversation.id;
}
export const appChecks = {
  async assert(source: ArtifactSource, id: string | undefined, identity: ArtifactIdentity, conversationId: string, db?: typeof sql) {
    if (!hasInterface(source)) return;
    const tables = id ? await artifactDatabase.checkDefinitions(id, identity, undefined, db) : [];
    const hash = checkHash(source, tables);
    const records = await (db ?? sql)<{ hash: string; passed: boolean }[]>`SELECT hash,passed FROM assistant.artifact_checks
      WHERE user_id=${user(identity).id}::uuid AND conversation_id=${conversationId}::uuid
      AND resource_key=${id ?? "files"} ORDER BY checked_at DESC`;
    const reason = checkGate(true, hash, records);
    if (reason) throw new CloudError("invalid", reason);
  },
  async start(raw: unknown, conversationId: string, identity: ArtifactIdentity, signal: AbortSignal) {
    const input = CodeCheckInput.parse(raw);
    await chat(conversationId, identity);
    // Recover crashed checks before allocating another disposable scope.
    await appChecks.cleanup().catch((error: unknown) => console.warn("Assistant check scratch cleanup deferred", error));
    signal.throwIfAborted();
    let scopeId: string | undefined;
    try {
      return await sql.begin(async (db) => {
        await databaseConfigLock(db);
        await db`SELECT pg_advisory_xact_lock(hashtext(${"assistant-check:" + user(identity).id}))`;
        const [live] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM assistant.artifacts a
          JOIN ai.conversations c ON c.id=a.check_conversation_id
          WHERE a.check_scratch AND c.created_by_user_id=${user(identity).id}::uuid`;
        if (live!.count >= CHECK_LIMITS.scopesPerUser)
          throw new CloudError("limit", "Too many code checks are running for this user; wait for one to finish.");
        // Keep source, definitions and the exported data under the same source
        // row lock as edits. Both check runs bind what was actually copied.
        const resource = input.id ? await requireArtifact(db, input.id, identity, "read") : undefined;
        const saved = resource
          ? await readArtifactRevision(
              db,
              resource.row,
              resource.permission,
              resource.permission === "admin" ? resource.row.revision : resource.row.published_revision!,
            )
          : undefined;
        const source = ArtifactSource.parse(saved?.source ?? { entry: "index.html", files: input.files });
        if (!hasInterface(source)) throw new CloudError("invalid", "code_check needs an index.html app; scripts use code_run.");
        let steps: ReturnType<typeof readCheckSteps>;
        try {
          steps = readCheckSteps(source.files);
        } catch (error) {
          throw new CloudError("invalid", `Invalid steps.json: ${error instanceof Error ? error.message : String(error)}`);
        }
        const tables = input.id ? await artifactDatabase.checkDefinitions(input.id, identity, signal, db) : [];
        const hash = checkHash(source, tables);
        const scratch = await artifacts.create({ kind: "app", title: "Code check", source }, identity, true);
        scopeId = scratch.id;
        // Commit the recovery marker before storage/remote database effects.
        await sql`UPDATE assistant.artifacts SET check_conversation_id=${conversationId}::uuid WHERE short_id=${scratch.id} AND check_scratch`;
        const warnings = input.id ? await artifactDatabase.copyForCheck(input.id, scratch.id, identity, signal, db) : [];
        if (resource) {
          const [usage] = await db`SELECT coalesce(sum(bytes),0)::bigint AS bytes FROM assistant.artifact_storage
            WHERE artifact_id=${resource.row.id}::uuid AND (user_id IS NULL OR user_id=${user(identity).id}::uuid)`;
          if (Number(usage!.bytes) > CHECK_LIMITS.outputBytes)
            throw new CloudError("limit", "App data copy exceeds the 250 MiB storage budget");
          await db`INSERT INTO assistant.artifact_storage(artifact_id,area,key,content,media_type,bytes,data,user_id,version)
            SELECT (SELECT id FROM assistant.artifacts WHERE short_id=${scratch.id}),area,key,content,media_type,bytes,data,user_id,version
            FROM assistant.artifact_storage WHERE artifact_id=${resource.row.id}::uuid AND (user_id IS NULL OR user_id=${user(identity).id}::uuid)`;
        }
        signal.throwIfAborted();
        return { artifactId: input.id, scopeId: scratch.id, source, steps, hash, warnings };
      });
    } catch (error) {
      if (scopeId) await appChecks.discard(scopeId, identity);
      throw error;
    }
  },
  async discard(id: string, identity: ArtifactIdentity) {
    const [row] =
      await sql`SELECT a.check_scratch,d.namespace FROM assistant.artifacts a LEFT JOIN assistant.artifact_databases d ON d.artifact_id=a.id WHERE a.short_id=${id}`;
    if (!row) return;
    if (!row.check_scratch) throw new ArtifactError("ACCESS_DENIED");
    await artifacts.remove(id, identity);
    if (typeof row.namespace === "string") await artifactDatabase.deleteQueuedNamespace(row.namespace);
  },
  async record(raw: unknown, inputRaw: unknown, conversationId: string, identity: ArtifactIdentity) {
    await chat(conversationId, identity);
    const input = CodeCheckInput.parse(inputRaw),
      report = CheckReport.parse(raw);
    if (report.passed && (report.issues.some((issue) => issue.severity === "error") || report.screenshots.length !== 3))
      throw new ArtifactError("INVALID_INPUT");
    // Keep the report's tested hash, never relabel it with a newer source hash.
    await sql`INSERT INTO assistant.artifact_checks(user_id,conversation_id,resource_key,hash,passed,height)
      VALUES(${user(identity).id}::uuid,${conversationId}::uuid,${input.id ?? "files"},${report.hash},${report.passed},${report.height})
      ON CONFLICT(user_id,conversation_id,resource_key,hash) DO UPDATE SET passed=excluded.passed,height=excluded.height,checked_at=now()`;
    // One-off hashes share the per-conversation bounded history.
    await sql`DELETE FROM assistant.artifact_checks WHERE user_id=${user(identity).id}::uuid AND conversation_id=${conversationId}::uuid
      AND hash IN (SELECT hash FROM assistant.artifact_checks WHERE user_id=${user(identity).id}::uuid
        AND conversation_id=${conversationId}::uuid ORDER BY checked_at DESC OFFSET ${CHECK_HISTORY})`;
  },
  async cleanup() {
    // Crash recovery uses the same durable namespace cleanup queue as app deletion.
    await sql.begin(async (db) => {
      const stale = await db<{ id: string }[]>`SELECT id FROM assistant.artifacts WHERE check_scratch
        AND updated_at < now()-interval '2 minutes' FOR UPDATE SKIP LOCKED LIMIT ${CHECK_CLEANUP_BATCH}`;
      for (const { id } of stale) {
        await db`INSERT INTO assistant.database_cleanup(namespace) SELECT namespace FROM assistant.artifact_databases WHERE artifact_id=${id}::uuid ON CONFLICT DO NOTHING`;
        await db`DELETE FROM auth.access WHERE id IN (SELECT access_id FROM assistant.artifact_access WHERE artifact_id=${id}::uuid)`;
        await db`DELETE FROM assistant.artifacts WHERE id=${id}::uuid`;
      }
    });
  },
};

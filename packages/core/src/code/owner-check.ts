import { getApp, sql } from "@k2b/cloud";
import type { SQL } from "bun";
import { CodeOwnerUnavailableError } from "./access";
import { readCodeResourceOwnerTitle } from "./activation-transport";
import type { Code } from "./contracts";

/** Read the current owner's title independently of whoever activated resource Code. */
export async function readCodeRunOwnerTitle(code: Code, db: SQL = sql, signal?: AbortSignal): Promise<string | null> {
  if (code.owner.kind === "person") {
    const [person] = await db<{ title: string }[]>`SELECT COALESCE(NULLIF(display_name,''),uid) AS title
      FROM auth.users WHERE id=${code.owner.userId}::uuid`;
    return person?.title ?? null;
  }
  try {
    if (code.owner.kind === "app") {
      const live = await getApp(code.owner.appId);
      if (live) return live.name;
      const [known] = await db<{ hidden_at: Date | null }[]>`SELECT hidden_at FROM core.known_apps WHERE id=${code.owner.appId}`;
      if (known && known.hidden_at === null) throw new CodeOwnerUnavailableError("Code owner reader unavailable");
      return null;
    }
    if (!code.serviceAccountId) throw new CodeOwnerUnavailableError("Code owner account unavailable");
    const appId = code.owner.ref.type.split(".")[0]!;
    if (!(await getApp(appId))) {
      const [removed] = await db`SELECT id FROM core.known_apps WHERE id=${appId} AND hidden_at IS NOT NULL`;
      if (removed) return null;
      throw new CodeOwnerUnavailableError("Code owner reader unavailable");
    }
    return await readCodeResourceOwnerTitle(code.owner.ref, code.serviceAccountId, signal);
  } catch {
    throw new CodeOwnerUnavailableError("Code owner reader unavailable");
  }
}

/**
 * Core execution guard, consumed by C13 after claiming and before signing a lease.
 * A missing owner pauses with owner_not_found; it never deletes Code. A reader
 * outage rejects execution and can be retried. Call OUTSIDE any caller transaction
 * or dispatch lock: network reads precede the short transaction that commits the
 * pause. On false, C13 must skip its claimed run without issuing a runner token.
 */
export async function checkCodeOwnerBeforeRun(code: Code, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const title = await readCodeRunOwnerTitle(code, sql, signal);
  signal?.throwIfAborted();
  return sql.begin(async (tx) => {
    const [current] = await tx<{ state: string }[]>`SELECT state FROM code.codes WHERE id=${code.id} FOR UPDATE`;
    if (!current || current.state === "deleting") return false;
    if (title !== null) {
      await tx`UPDATE code.codes SET owner_title=${title} WHERE id=${code.id} AND owner_title IS DISTINCT FROM ${title}`;
      return current.state === "active";
    }
    await tx`UPDATE code.codes SET state='paused',pause_reason='owner_not_found',pause_rows='{}',pause_policy_revision=NULL
      WHERE id=${code.id} AND state<>'deleting'`;
    await tx`UPDATE code.runs SET state='skipped',outcome='owner_not_found',ended_at=clock_timestamp()
      WHERE code_id=${code.id} AND state='queued'`;
    return false;
  });
}

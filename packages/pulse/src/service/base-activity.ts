import type { RequestActor } from "@k2b/cloud/contracts";
import type { sql } from "bun";

/** Store only the real acting principal; a delegation does not identify an approving person. */
export const recordBaseActivity = async (
  db: typeof sql,
  input: { baseId: string; actor?: RequestActor; requestId?: string; kind: string; data: Record<string, unknown>; at?: Date },
): Promise<void> => {
  const actor = input.actor
    ? input.actor.kind === "user"
      ? { kind: "user", id: input.actor.user.id, name: input.actor.user.displayName }
      : { kind: "service_account", id: input.actor.serviceAccount.id, name: input.actor.serviceAccount.name }
    : null;
  await db`INSERT INTO pulse.base_activity(base_id,kind,actor,request_id,data,at)
    VALUES(${input.baseId}::uuid,${input.kind},(${JSON.stringify(actor)}::jsonb #>> '{}')::jsonb,
      ${input.requestId ?? null},(${JSON.stringify(input.data)}::jsonb #>> '{}')::jsonb,coalesce(${input.at ?? null}::timestamptz,now()))`;
};

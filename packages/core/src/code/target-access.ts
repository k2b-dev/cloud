import { sql } from "@k2b/cloud";
import { invokeCodeAccess } from "@k2b/cloud/capabilities/server";
import {
  CODE_ACCESS_ACCOUNTS_MAX,
  CodeAccessListDataSchema,
  type CodeGrantDetail,
  CodeGrantDetailSchema,
  CodeGrantDetailsInputSchema,
  capabilityResultSchema,
} from "@k2b/cloud/contracts";
import type { SQL } from "bun";
import { z } from "zod";
import { type CodeContext, codePerson } from "./access";

export const codeGrantDetailsContracts = {
  input: CodeGrantDetailsInputSchema,
  data: z.array(CodeGrantDetailSchema).max(CODE_ACCESS_ACCOUNTS_MAX),
} as const;

// One list call per Code account; a share list rarely names more than a few, bound the parallel calls all the same.
const LIST_CONCURRENCY = 8;

/** The target decides: only grants its `code.access.list` returns for this person, at targets they manage, appear. */
const managedGrantIds = async (
  appId: string,
  principals: string[],
  context: CodeContext,
  request: Request,
  invoke: typeof invokeCodeAccess,
): Promise<Set<string>> => {
  const visible = new Set<string>();
  for (let start = 0; start < principals.length; start += LIST_CONCURRENCY) {
    context.signal?.throwIfAborted();
    await Promise.all(
      principals.slice(start, start + LIST_CONCURRENCY).map(async (principal) => {
        const response = await invoke({
          request,
          appId,
          operation: "list",
          input: { principal },
          authority: context.authority,
          locale: context.locale,
        });
        if (!response.ok) return;
        const result = capabilityResultSchema(CodeAccessListDataSchema, { consumer: true }).safeParse(
          await response.json().catch(() => null),
        );
        if (!result.success) return;
        for (const grant of result.data.data) if (grant.principal === principal) visible.add(grant.grantId);
      }),
    );
  }
  return visible;
};

/**
 * Details for the "Code with access" rows of a target's share dialog. Each grant appears only when the target's
 * own `code.access.list` returns it for the viewer, which happens only at targets the viewer manages. Names follow
 * directory visibility: members see other people's names, guests only their own.
 */
export const readCodeGrantDetails = async (
  input: z.infer<typeof CodeGrantDetailsInputSchema>,
  context: CodeContext,
  request: Request,
  dependencies: { invoke?: typeof invokeCodeAccess; db?: SQL } = {},
): Promise<CodeGrantDetail[]> => {
  const viewer = codePerson(context);
  const db = dependencies.db ?? sql;
  const requested = new Map(input.grants.map((grant) => [grant.grantId, grant.principal]));
  const visible = await managedGrantIds(
    input.appId,
    [...new Set(requested.values())],
    context,
    request,
    dependencies.invoke ?? invokeCodeAccess,
  );
  const ids = [...requested.keys()].filter((id) => visible.has(id));
  if (ids.length === 0) return [];
  // The grant must belong to the same Code account the target listed it for.
  const rows = await db<
    { grant_id: string; principal: string; operations: string[]; activating_person: string | null; activated_at: Date | null }[]
  >`SELECT g.grant_id, c.service_account_id AS principal, g.operations, a.activating_person,
      CASE WHEN a.state='active' THEN a.updated_at END AS activated_at
    FROM code.target_grants g JOIN code.activations a ON a.id=g.activation_id JOIN code.codes c ON c.id=g.code_id
    WHERE g.grant_id = ANY(${ids}::uuid[]) AND g.state='granted'`;
  const matching = rows.filter((row) => requested.get(row.grant_id) === row.principal);
  const directory = viewer.roles.includes("user");
  const people = [
    ...new Set(
      matching.flatMap((row) =>
        row.activating_person && (directory || row.activating_person === viewer.id) ? [row.activating_person] : [],
      ),
    ),
  ];
  const names = new Map(
    people.length
      ? (
          await db<{ id: string; display_name: string | null; given_name: string | null; sn: string | null; uid: string }[]>`
            SELECT id, display_name, given_name, sn, uid FROM auth.users WHERE id = ANY(${people}::uuid[])`
        ).map((row) => [row.id, row.display_name?.trim() || `${row.given_name ?? ""} ${row.sn ?? ""}`.trim() || row.uid])
      : [],
  );
  return matching.map((row) => {
    const name = row.activating_person ? names.get(row.activating_person) : undefined;
    return {
      grantId: row.grant_id,
      operations: [...row.operations].sort(),
      activatedBy: row.activating_person && name ? { id: row.activating_person, name } : null,
      activatedAt: row.activated_at ? row.activated_at.toISOString() : null,
    };
  });
};

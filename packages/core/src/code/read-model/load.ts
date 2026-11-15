import { sql } from "@k2b/cloud";
import { CodeCheckedVersionManifestSchema, type CodeVersionReadModel, codeReadModelContracts } from "@k2b/cloud/contracts";
import type { z } from "zod";
import { type CodeContext, CodeDataError } from "../access";
import { codeChatMissing } from "../chat-binding";
import { codePolicyGroupRowsQuery, codePolicyGroupsFromRows, codePolicySnapshotFromRow, codePolicySnapshotQuery } from "../policy";
import { effective } from "../policy-effective";
import { codeSettings } from "../settings";
import { readCode } from "../store";
import { CodeVersionEvidenceSchema } from "../version-evidence";
import { codeReadModelMessages } from "./messages";
import { readModelNames } from "./names";
import { describeCodeNotices } from "./notices";
import { presentCodeVersion, readModelList } from "./present";

/** One authorized projection for Chat, Code pages, Waiting for you and /admin/code; never reads source. */
export async function loadCodeVersionReadModel(
  raw: z.input<typeof codeReadModelContracts.version.input>,
  context: CodeContext,
): Promise<CodeVersionReadModel> {
  context = { ...context, ownerReaderAnswer: null };
  const input = codeReadModelContracts.version.input.parse(raw);
  const { code } = await readCode(input.codeId, context);
  const { locale } = codeReadModelMessages.resolve(context.locale ? [context.locale] : []);
  const [row] = await sql<
    {
      policy: (Omit<Parameters<typeof codePolicySnapshotFromRow>[0], "updated_at"> & { updated_at: string }) | null;
      memberships: Parameters<typeof codePolicyGroupsFromRows>[0];
      number: number;
      created_at: Date;
      manifest: unknown;
      comparison: unknown;
      comparison_id: string | null;
      expected_comparison_id: string | null;
      evidence: unknown;
      explanation: string | null;
    }[]
  >`SELECT (SELECT row_to_json(p) FROM (${codePolicySnapshotQuery(sql)}) p) AS policy,
    (SELECT COALESCE(jsonb_agg(g),'[]'::jsonb) FROM (${codePolicyGroupRowsQuery(code.owner.kind === "person" ? code.owner.userId : null, sql, input.versionId)}) g) AS memberships,
    v.number,v.created_at,v.manifest,s.evidence,cmp.manifest AS comparison,cmp.id AS comparison_id,CASE WHEN ${input.comparisonVersionId !== undefined} THEN ${input.comparisonVersionId ?? null}::uuid ELSE (s.binding->>'comparisonVersionId')::uuid END AS expected_comparison_id,e.text AS explanation
    FROM code.versions v LEFT JOIN code.version_submissions s ON s.version_id=v.id
    LEFT JOIN code.versions cmp ON cmp.code_id=v.code_id AND cmp.id=CASE WHEN ${input.comparisonVersionId !== undefined}
      THEN ${input.comparisonVersionId ?? null}::uuid ELSE (s.binding->>'comparisonVersionId')::uuid END
    LEFT JOIN code.version_explanations e ON e.version_id=v.id AND e.locale=${locale}
    WHERE v.id=${input.versionId}::uuid AND v.code_id=${input.codeId}`;
  if (!row) throw new CodeDataError("NOT_FOUND", "Code version not found.");
  if (input.comparisonVersionId && !row.comparison_id) throw new CodeDataError("NOT_FOUND", "Comparison version not found.");
  const manifest = CodeCheckedVersionManifestSchema.parse(row.manifest);
  const comparison = CodeCheckedVersionManifestSchema.safeParse(row.comparison);
  const evidence = CodeVersionEvidenceSchema.safeParse(row.evidence);
  const policy = row.policy ? codePolicySnapshotFromRow({ ...row.policy, updated_at: new Date(row.policy.updated_at) }) : null;
  const membership = codePolicyGroupsFromRows(row.memberships);
  const result = presentCodeVersion({
    versionId: input.versionId,
    number: row.number,
    submittedAt: row.created_at.toISOString(),
    manifest,
    comparison: comparison.success ? comparison.data : null,
    comparisonAvailable: row.expected_comparison_id === null || comparison.success,
    evidence: evidence.success ? evidence.data : null,
    explanation: row.explanation,
    policy: policy
      ? Object.fromEntries(
          manifest.policyRows.map((classification) => [
            classification,
            effective(classification, code.owner, policy.definition, membership).value,
          ]),
        )
      : {},
    names: await readModelNames([manifest, ...(comparison.success ? [comparison.data] : [])], context),
    locale,
    limits: { cases: await codeSettings.get("core.code.test_cases") },
  });
  if (await codeChatMissing(code.id))
    result.notices = readModelList(
      [{ ...describeCodeNotices([{ code: "chat_missing" }], locale)[0]!, code: "chat_missing" as const }, ...result.notices.items],
      locale,
      result.notices.more,
    );
  return result;
}

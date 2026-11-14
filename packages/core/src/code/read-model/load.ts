import { sql } from "@k2b/cloud";
import { CodeCheckedVersionManifestSchema, type CodeVersionReadModel, codeReadModelContracts } from "@k2b/cloud/contracts";
import type { z } from "zod";
import { type CodeContext, CodeDataError } from "../access";
import { codeSettings } from "../settings";
import { readCode } from "../store";
import { CodeVersionEvidenceSchema } from "../version-evidence";
import { codeReadModelMessages } from "./messages";
import { readModelNames } from "./names";
import { presentCodeVersion } from "./present";

/** One authorized projection for Chat, Code pages, Waiting for you and /admin/code; never reads source. */
export async function loadCodeVersionReadModel(
  raw: z.input<typeof codeReadModelContracts.version.input>,
  context: CodeContext,
): Promise<CodeVersionReadModel> {
  const input = codeReadModelContracts.version.input.parse(raw);
  await readCode(input.codeId, context);
  const { locale } = codeReadModelMessages.resolve(context.locale ? [context.locale] : []);
  const [row] = await sql<
    {
      number: number;
      created_at: Date;
      manifest: unknown;
      comparison: unknown;
      comparison_id: string | null;
      expected_comparison_id: string | null;
      evidence: unknown;
      explanation: string | null;
    }[]
  >`SELECT v.number,v.created_at,v.manifest,s.evidence,cmp.manifest AS comparison,cmp.id AS comparison_id,CASE WHEN ${input.comparisonVersionId !== undefined} THEN ${input.comparisonVersionId ?? null}::uuid ELSE (s.binding->>'comparisonVersionId')::uuid END AS expected_comparison_id,e.text AS explanation
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
  return presentCodeVersion({
    versionId: input.versionId,
    number: row.number,
    submittedAt: row.created_at.toISOString(),
    manifest,
    comparison: comparison.success ? comparison.data : null,
    comparisonAvailable: row.expected_comparison_id === null || comparison.success,
    evidence: evidence.success ? evidence.data : null,
    explanation: row.explanation,
    names: await readModelNames([manifest, ...(comparison.success ? [comparison.data] : [])], context),
    locale,
    limits: { cases: await codeSettings.get("core.code.test_cases") },
  });
}

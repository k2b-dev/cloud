import { z } from "zod";
import type { CodeContext } from "./access";
import { CodeVersionSchema } from "./contracts";
import { requireCodeSourcePermission } from "./source-access";
import { readCode, readCodeVersion } from "./store";
import { listCodeVersions, readCodeVersionDiff } from "./versions";

const chunk = z.strictObject({ text: z.string(), nextOffset: z.number().int().nullable() });
/** Editor-only data for the Code tab. Source and diff use independent, bounded cursors. */
export const codeSourceTabContract = {
  input: z.strictObject({
    codeId: z.string().describe("Automation to open."),
    comparisonVersionId: z
      .uuid()
      .nullable()
      .optional()
      .describe("Any saved version of this automation to compare against the enabled version."),
    path: z.string().optional().describe("Source file in the enabled version; omit for its first file."),
    sourceOffset: z.number().int().nonnegative().default(0).describe("Next source chunk offset."),
    diffOffset: z.number().int().nonnegative().default(0).describe("Next difference chunk offset."),
    before: z.number().int().positive().optional().describe("Next version list cursor."),
  }),
  data: z.strictObject({
    enabled: CodeVersionSchema.nullable(),
    path: z.string().nullable(),
    source: chunk.nullable(),
    difference: chunk.nullable(),
    versions: z.array(z.strictObject({ versionId: z.uuid(), number: z.number().int().positive(), submittedAt: z.string() })).max(50),
    nextBefore: z.number().int().positive().nullable(),
  }),
};
export type CodeSourceTab = z.infer<typeof codeSourceTabContract.data>;
export async function loadCodeSourceTab(raw: z.input<typeof codeSourceTabContract.input>, context: CodeContext): Promise<CodeSourceTab> {
  const input = codeSourceTabContract.input.parse(raw);
  const { code } = await readCode(input.codeId, context);
  await requireCodeSourcePermission(code, context);
  const history = await listCodeVersions({ codeId: code.id, before: input.before, limit: 50 }, context);
  // A pending or newer submission never stands in for the version that is enabled (also while paused).
  const enabled = code.activeVersionId
    ? (await readCodeVersion({ codeId: code.id, versionId: code.activeVersionId, offset: 0, length: 1 }, context)).version
    : null;
  const path = input.path ?? enabled?.files[0] ?? null;
  const source =
    enabled && path
      ? (
          await readCodeVersion(
            { codeId: code.id, versionId: enabled.id, content: { kind: "source", path }, offset: input.sourceOffset, length: 16_384 },
            context,
          )
        ).content
      : null;
  const difference =
    enabled && input.comparisonVersionId !== undefined
      ? (
          await readCodeVersionDiff(
            {
              codeId: code.id,
              versionId: enabled.id,
              comparisonVersionId: input.comparisonVersionId,
              offset: input.diffOffset,
              length: 16_384,
            },
            context,
          )
        ).content
      : null;
  return {
    enabled,
    path: enabled ? path : null,
    source,
    difference,
    versions: history.items.map(({ version }) => ({ versionId: version.id, number: version.number, submittedAt: version.createdAt })),
    nextBefore: history.nextBefore,
  };
}

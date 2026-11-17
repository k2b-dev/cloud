import { invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities";
import { CodePageLinksSchema } from "@k2b/cloud/contracts/code-routes";
import { z } from "zod";

const CodeStateSchema = z.object({
  code: z.object({
    state: z.enum(["draft", "active", "paused", "deleting"]),
    activeVersionId: z.string().nullable(),
    pausedAt: z.string().nullable().optional(),
    pausedBy: z.object({ name: z.string() }).nullable().optional(),
  }),
});
export type CodeVersionCardCode = z.infer<typeof CodeStateSchema>["code"];

/** Public Core queries, just as on the Code page. Page selection belongs only to describeCodePages on the server. */
export async function loadCodeVersionCardContext(codeId: string, versionId: string) {
  const query = <T extends z.ZodType>(capabilityId: string, input: unknown, schema: T) =>
    invokeCapabilityWithDataSchema({ appId: "core", capabilityId, kind: "query", input }, schema).catch(() => null);
  const [state, links] = await Promise.all([
    query("code.read", { codeId }, CodeStateSchema),
    query(
      "code.version.read",
      { codeId, versionId, content: { kind: "manifest" }, offset: 0, length: 1 },
      z.object({ pages: CodePageLinksSchema.nullable() }),
    ),
  ]);
  const pages = links?.ok ? links.data.data.pages : null;
  return {
    code: state?.ok ? state.data.data.code : null,
    pages: pages?.versionId === versionId ? pages : null,
  };
}

/** A replaced card links to the actual newest version, never an invented version ID. */
export async function loadLatestCodeVersion(codeId: string) {
  const answer = await invokeCapabilityWithDataSchema(
    { appId: "core", capabilityId: "code.version.list", kind: "query", input: { codeId, limit: 1 } },
    z.object({ items: z.array(z.object({ version: z.object({ id: z.string(), number: z.number() }) })) }),
  ).catch(() => null);
  return answer?.ok ? (answer.data.data.items[0]?.version ?? null) : null;
}

import { CodePageLinksSchema } from "@k2b/cloud/contracts";
import { z } from "zod";

const HandoffSchema = z.object({
  title: z.string(),
  pages: CodePageLinksSchema.nullable().optional(),
});
export type CodeDecisionPages = { title: string; pages: z.infer<typeof CodePageLinksSchema> };

/** The existing Core preview checks current management rights, including on a reloaded history line. */
export async function loadCodeDecisionPages(
  codeId: string,
  versionId: string,
  signal?: AbortSignal,
): Promise<CodeDecisionPages | null | "failed"> {
  try {
    const response = await fetch("/api/code/activation/preview", {
      method: "POST",
      signal,
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ codeId, versionId }),
    });
    if (response.status === 403 || response.status === 404) return null;
    if (!response.ok) return "failed";
    const read = z.object({ data: HandoffSchema }).safeParse(await response.json());
    if (!read.success) return "failed";
    const { title, pages } = read.data.data;
    return pages?.pages.length ? { title, pages } : null;
  } catch {
    return "failed";
  }
}

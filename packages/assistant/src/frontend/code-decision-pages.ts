import { CodePageLinksSchema } from "@k2b/cloud/contracts";
import { z } from "zod";
import { codeVersionPageHref } from "./code-activation";

const HandoffSchema = z.object({
  title: z.string(),
  codeId: z.string(),
  ownerKind: z.enum(["person", "resource", "app"]),
  page: z.string().nullable().optional(),
  pages: CodePageLinksSchema.nullable().optional(),
});
export type CodeDecisionPages = { title: string; codePageHref: string | null; pages: z.infer<typeof CodePageLinksSchema> };

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
    return pages?.pages.length ? { title, pages, codePageHref: codeVersionPageHref(read.data.data) } : null;
  } catch {
    return "failed";
  }
}

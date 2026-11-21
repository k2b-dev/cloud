import { z } from "zod";

/**
 * Core's `GET /api/code/usage` for one base (K1, F4): the Code pages and automations that read it in the last thirty
 * days and that this person may open, plus a count of the others without names. Apps do not import Core, so the
 * answer's shape is repeated here and checked on arrival.
 */
const CodeUsageSchema = z.object({
  items: z.array(
    z.object({
      codeId: z.string(),
      title: z.string(),
      kind: z.enum(["page", "automation"]),
      owner: z.string().nullable(),
      lastCalledAt: z.string(),
      // One path on this Cloud: "//" or "/\\" would name another host.
      href: z.string().regex(/^\/(?![/\\])/),
    }),
  ),
  others: z.number().int().nonnegative(),
  since: z.string(),
});
export type CodeUsage = z.infer<typeof CodeUsageSchema>;
export type CodeUsageItem = CodeUsage["items"][number];

/** `forbidden`: the person may not read the base. `unavailable`: Core or the check did not answer. */
export type CodeUsageResult = { ok: true; data: CodeUsage } | { ok: false; error: "forbidden" | "unavailable" };

export async function loadCodeUsage(baseShortId: string, signal?: AbortSignal): Promise<CodeUsageResult> {
  const search = new URLSearchParams({ type: "pulse.base", id: baseShortId });
  let response: Response;
  try {
    response = await fetch(`/api/code/usage?${search}`, {
      credentials: "same-origin",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    // An abort belongs to the caller, which started a newer load or left the tab.
    if (signal?.aborted) throw error;
    return { ok: false, error: "unavailable" };
  }
  if (response.status === 403) return { ok: false, error: "forbidden" };
  if (!response.ok) return { ok: false, error: "unavailable" };
  const body = z.object({ data: CodeUsageSchema }).safeParse(await response.json().catch(() => null));
  return body.success ? { ok: true, data: body.data.data } : { ok: false, error: "unavailable" };
}

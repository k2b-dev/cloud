import type { z } from "zod";
import { type CodePageProvenance, codePageProvenanceRoutes } from "./page-provenance-contracts";

/** Which page the label belongs to: the Code, the page's path without query, and the delivered version value. */
export type CodePageRef = { codeId: string; path: string; version: string };

/** An answer of the card's routes: the data, a refusal with its stable code, or no usable answer at all. */
export type ProvenanceAnswer<T> = { kind: "ok"; data: T } | { kind: "failed"; code: string | undefined } | { kind: "lost" };

/** One POST with a JSON body; a missing or unreadable answer is `lost`, never a guess. Never retries. */
async function post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<ProvenanceAnswer<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    return { kind: "lost" };
  }
  const json: unknown = await response.json().catch(() => undefined);
  if (response.ok) {
    const data = json && typeof json === "object" && "data" in json ? schema.safeParse(json.data) : undefined;
    return data?.success ? { kind: "ok", data: data.data } : { kind: "lost" };
  }
  const code = json && typeof json === "object" && "code" in json && typeof json.code === "string" ? json.code : undefined;
  return { kind: "failed", code };
}

/** The card's facts for this viewer, asked once on its first opening. */
export const readCodePageProvenance = (page: CodePageRef): Promise<ProvenanceAnswer<CodePageProvenance>> =>
  post(codePageProvenanceRoutes.read.path, page, codePageProvenanceRoutes.read.data);

export type CodePageReportInput = CodePageRef & {
  reason: z.infer<typeof codePageProvenanceRoutes.report.input>["reason"];
  text: string;
  key: string;
};

/** Files a report. The key makes a resend after a lost answer return the same report instead of a second one. */
export const sendCodePageReport = (input: CodePageReportInput): Promise<ProvenanceAnswer<{ reportedAt: string }>> =>
  post(codePageProvenanceRoutes.report.path, input, codePageProvenanceRoutes.report.data);

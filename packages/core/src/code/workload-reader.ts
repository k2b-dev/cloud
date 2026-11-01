import { sql } from "@k2b/cloud";
import { getCapabilityCatalogApp } from "@k2b/cloud/capabilities/server";
import {
  type CapabilitySemanticLink,
  type CloudResourceReaderView,
  CloudResourceReaderViewSchema,
  cloudResourceHref,
} from "@k2b/cloud/contracts";
import { z } from "zod";
import { type CodeContext, CodeDataError, codeAccountDisplayName } from "./access";
import { readCode } from "./store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reader for the `core.code.version` resource a Code call names as its workload (`actorWorkload`). The id is the
 * version, followed by `~<run>` when the call belongs to a run. Apps show the result in their history without knowing
 * Code. Whoever may not read the Code, and any Code that is gone, get the same NOT_FOUND.
 */
export const codeWorkloadReaderContract = {
  input: z.object({ id: z.string().min(1).max(100).describe("Version UUID, optionally followed by ~ and a run UUID.") }).strict(),
  data: z.object({ view: CloudResourceReaderViewSchema }).strict(),
};

const pageOf = async (code: Awaited<ReturnType<typeof readCode>>["code"], context: CodeContext): Promise<string | null> => {
  if (code.owner.kind !== "resource") return null;
  const { ref } = code.owner;
  const appId = ref.type.split(".")[0] ?? "";
  const catalog = await getCapabilityCatalogApp(appId, context.locale, context.authority).catch(() => null);
  const page = catalog?.ok ? catalog.data?.manifest.code?.pages?.[ref.type.slice(appId.length + 1)] : undefined;
  return page ? page.replace("{id}", encodeURIComponent(ref.id)) : cloudResourceHref(ref);
};

export async function readCodeWorkload(
  id: string,
  context: CodeContext,
): Promise<{ view: CloudResourceReaderView; links: CapabilitySemanticLink[] }> {
  const [versionId, runId, extra] = id.split("~");
  if (!versionId || !UUID.test(versionId) || extra !== undefined || (runId !== undefined && !UUID.test(runId)))
    throw new CodeDataError("NOT_FOUND", "Code not found.");
  const [version] = await sql<{ code_id: string }[]>`SELECT code_id FROM code.versions WHERE id=${versionId}::uuid`;
  if (!version) throw new CodeDataError("NOT_FOUND", "Code not found.");
  const { code, permission } = await readCode(version.code_id, context);
  const [run] = runId
    ? await sql<{ entrypoint: string }[]>`SELECT entrypoint FROM code.runs WHERE id=${runId}::uuid AND version_id=${versionId}::uuid`
    : [];
  const page = await pageOf(code, context);
  const links: CapabilitySemanticLink[] = page
    ? [
        { rel: "open", href: page },
        // A pruned run keeps its entry in other apps' history; only its own link goes.
        ...(run ? [{ rel: "status" as const, href: `${page}${page.includes("?") ? "&" : "?"}tab=runs&run=${runId}` }] : []),
      ]
    : [];
  return {
    view: {
      title: ((await codeAccountDisplayName(code, context)) ?? code.title).slice(0, 500),
      ...(run ? { context: run.entrypoint.slice(0, 200) } : {}),
      permission: permission === "editor" ? "write" : "read",
    },
    links,
  };
}

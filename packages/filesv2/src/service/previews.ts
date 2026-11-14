import { sql } from "@k2b/cloud";
import { logger, type PreviewSource, PreviewSourceChanged, previews } from "@k2b/cloud/services";
import type { Node } from "@k2b/filegate";
import { z } from "zod";
import type { BaseSummary } from "../contracts";
import { markdownRevision } from "../document-assets";
import { readConfiguration } from "./configuration";
import { FilesError } from "./errors";
import { connectFilegate } from "./filegate-facade";
import { joinPath, userPath } from "./paths";

export function filePreviewSource(base: Pick<BaseSummary, "id" | "stableIds">, path: string, node: Node): PreviewSource {
  if (node.directory) throw new FilesError("preview_unsupported", 404);
  const source = {
    key: `${base.id}:${base.stableIds && node.id ? node.id : path}`,
    revision: markdownRevision(node),
    name: path.split("/").at(-1)!,
    size: node.size,
    locator: JSON.stringify({ baseId: base.id, path }),
  };
  if (Buffer.byteLength(source.key) > 512 || Buffer.byteLength(source.locator) > 2048) throw new FilesError("preview_unsupported", 404);
  return source;
}
/** Cache warmup cannot turn an already committed file publication into a failed write. */
export async function enqueueFilePreview(base: Pick<BaseSummary, "id" | "stableIds">, path: string, node: Node): Promise<void> {
  if (node.directory) return;
  try {
    await previews.enqueue(filePreviewSource(base, path, node));
  } catch {
    logger("filesv2:previews").warn("Preview warmup unavailable; a view can retry");
  }
}

const Locator = z.object({ baseId: z.string(), path: z.string() });
/** Called only by the platform worker after the owning service authorized and described the source. */
export async function readFilePreview(source: Pick<PreviewSource, "key" | "revision" | "locator">, signal: AbortSignal): Promise<Response> {
  const { baseId, path: rawPath } = Locator.parse(JSON.parse(source.locator));
  const match = /^(cloud|freeipa):(users|groups):([0-9a-f-]{36})$/i.exec(baseId);
  if (!match) throw new PreviewSourceChanged();
  const path = userPath(rawPath);
  if (!path) throw new PreviewSourceChanged();
  const [binding] = await sql<{ root: string; path: string; storage: boolean; server_url: string | null }[]>`
    SELECT base.root, base.path, storage.base_id IS NOT NULL AS storage, storage.server_url
    FROM filesv2.bases base LEFT JOIN filesv2.machine_storage storage ON storage.base_id=base.id
    WHERE base.area=${match[1]} AND base.kind=${match[2]} AND base.identity_id=${match[3]}::uuid AND base.lifecycle='active'`;
  if (!binding) throw new PreviewSourceChanged();
  const config = await readConfiguration();
  if (binding.server_url && binding.server_url !== config.url) throw new PreviewSourceChanged();
  const client = connectFilegate(config, undefined, signal);
  const root = client.root(binding.root);
  const target = joinPath(binding.path, path);
  const info = await root.info();
  let node: Node;
  try {
    node = await root.stat(target);
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 404) throw new PreviewSourceChanged();
    throw error;
  }
  if (
    node.directory ||
    markdownRevision(node) !== source.revision ||
    filePreviewSource({ id: baseId, stableIds: info.stableIds === true }, path, node).key !== source.key
  )
    throw new PreviewSourceChanged();
  const response = binding.storage
    ? await root.contentRaw(target, signal)
    : await client.downloadRaw(await root.directDownload(target, { expiresIn: 60 }), signal);
  // Re-stat after opening the bytes too, so a replacement during lease creation cannot populate an old revision.
  try {
    const current = await root.stat(target);
    if (markdownRevision(current) !== source.revision || current.id !== node.id) throw new PreviewSourceChanged();
  } catch (error) {
    await response.body?.cancel();
    if (error instanceof Error && "status" in error && error.status === 404) throw new PreviewSourceChanged();
    throw error;
  }
  return response;
}

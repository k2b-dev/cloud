import {
  type AiFileLocation,
  type AiFileReference,
  AiFileVersionConflict,
  aiConversations,
  aiFileContentVersion,
  aiProjects,
  listAiConversationFiles,
  normalizeAiFilePath,
  readAiConversationFile,
  writeAiConversationFile,
} from "@k2b/cloud/ai";
import { z } from "zod";
import { ArtifactError, type ArtifactIdentity, user } from "./identity";

type Container = Pick<AiFileLocation, "scope" | "id">;
async function resolve(location: Container, identity: ArtifactIdentity, write = false) {
  if ("path" in location && typeof location.path === "string") {
    const path = location.path;
    const canonical = location.scope === "project" ? path.trim().replace(/\\/g, "/").replace(/^\/+/, "") : normalizeAiFilePath(path);
    if (!canonical || canonical !== path || path.split("/").some((part) => part === "." || part === ".."))
      throw new ArtifactError("INVALID_INPUT");
  }
  if (location.scope === "project") {
    const permission = write ? "write" : "read";
    const project = z.uuid().safeParse(location.id).success
      ? await aiProjects.get(location.id, identity, permission)
      : await aiProjects.getByShortId(location.id, identity, permission);
    if (!project) throw new ArtifactError("ACCESS_DENIED");
    return { scope: location.scope, id: project.id, title: project.name };
  }
  const input = { ownerUserId: user(identity).id };
  const chat = z.uuid().safeParse(location.id).success
    ? await aiConversations.getConversation({ ...input, conversationId: location.id })
    : await aiConversations.getConversationByShortId({ ...input, shortId: location.id });
  if (!chat || chat.archivedAt) throw new ArtifactError("ACCESS_DENIED");
  return { scope: location.scope, id: chat.id, title: chat.title };
}
export const chatFiles = {
  async list(container: Container, identity: ArtifactIdentity, after = "", limit = 100) {
    const resolved = await resolve(container, identity);
    let items: { path: string; size: number; mediaType: string }[];
    if (resolved.scope === "project") {
      items = await aiProjects.listFiles(resolved.id, identity, { after, limit });
    } else items = await listAiConversationFiles(resolved.id, undefined, { after, limit });
    return {
      container: resolved,
      items: items.map((item) => ({
        path: item.path,
        size: item.size,
        mediaType: item.mediaType,
        location: { scope: resolved.scope, id: resolved.id, path: item.path },
      })),
      nextAfter: items.length === limit ? items.at(-1)!.path : null,
    };
  },
  async read(location: AiFileLocation, identity: ArtifactIdentity) {
    const resolved = await resolve(location, identity);
    let file: { bytes: Uint8Array; mediaType: string; version: string } | null = null;
    if (resolved.scope === "project") {
      const result = await aiProjects.readFileByPath(resolved.id, location.path, identity);
      if (result) file = { bytes: result.bytes, mediaType: result.mediaType, version: aiFileContentVersion(result) };
    } else {
      const result = await readAiConversationFile({ conversationId: resolved.id, ownerUserId: user(identity).id, path: location.path });
      if (result)
        file = {
          bytes: result.bytes,
          mediaType: result.mediaType,
          version: aiFileContentVersion({ ...result, id: `${resolved.id}:${location.path}:${result.version}` }),
        };
    }
    return file
      ? {
          ...file,
          title: resolved.title,
          reference: { scope: resolved.scope, id: resolved.id, path: location.path, version: file.version },
        }
      : null;
  },
  async readReference(reference: AiFileReference, identity: ArtifactIdentity) {
    const file = await chatFiles.read(reference, identity);
    if (!file || file.version !== reference.version) throw new ArtifactError("CONFLICT");
    return file;
  },
  async destination(location: AiFileLocation, expectedVersion: string | null, identity: ArtifactIdentity) {
    const resolved = await resolve(location, identity, true);
    const current = await chatFiles.read({ ...location, id: resolved.id }, identity);
    if ((current?.version ?? null) !== expectedVersion) throw new ArtifactError("CONFLICT");
    return resolved;
  },
  async copy(
    source: AiFileReference,
    destination: AiFileLocation,
    expectedVersion: string | null,
    identity: ArtifactIdentity,
    signal: AbortSignal,
  ) {
    const target = await chatFiles.destination(destination, expectedVersion, identity);
    const file = await chatFiles.readReference(source, identity);
    signal.throwIfAborted();
    try {
      if (target.scope === "project") {
        const result = await aiProjects.writeFile(target.id, identity, {
          path: destination.path,
          mediaType: file.mediaType,
          bytes: file.bytes,
          expectedVersion,
        });
        if (!result) throw new ArtifactError("ACCESS_DENIED");
      } else {
        await writeAiConversationFile({
          conversationId: target.id,
          ownerUserId: user(identity).id,
          path: destination.path,
          mediaType: file.mediaType,
          bytes: file.bytes,
          expectedVersion,
        });
      }
    } catch (error) {
      if (error instanceof AiFileVersionConflict) throw new ArtifactError("CONFLICT");
      throw error;
    }
    const stored = await chatFiles.read({ ...destination, id: target.id }, identity);
    if (!stored) throw new ArtifactError("CONFLICT");
    return { reference: stored.reference, size: stored.bytes.byteLength, mediaType: stored.mediaType };
  },
};

import { z } from "zod";
import {
  AiFileLocation,
  AiFileReference,
  aiConversations,
  aiProjects,
  aiFileContentVersion,
  AiFileVersionConflict,
  normalizeAiFilePath,
  listAiConversationFiles,
  readAiConversationFile,
  writeAiConversationFile,
} from "@k2b/cloud/ai";
import { artifacts, ArtifactError, user, type ArtifactIdentity } from "./service";

type Container = Pick<AiFileLocation, "scope" | "id">;
async function resolve(location: Container, identity: ArtifactIdentity, write = false) {
  if (location.scope !== "app" && "path" in location && typeof location.path === "string") {
    const path = location.path;
    const canonical = location.scope === "project" ? path.trim().replace(/\\/g, "/").replace(/^\/+/, "") : normalizeAiFilePath(path);
    if (!canonical || canonical !== path || path.split("/").some((part) => part === "." || part === ".."))
      throw new ArtifactError("INVALID_INPUT");
  }
  if (location.scope === "app") {
    const resource = await artifacts.get(location.id, identity);
    return { scope: location.scope, id: resource.id, title: resource.title };
  }
  if (location.scope === "project") {
    const permission = write ? "write" : "read";
    const project = z.uuid().safeParse(location.id).success
      ? await aiProjects.get(location.id, identity.accessSubject, permission)
      : await aiProjects.getByShortId(location.id, identity.accessSubject, permission);
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
const numericVersion = (version: string | null) => (version === null ? null : z.coerce.number().int().positive().safe().parse(version));

export const studioFiles = {
  async list(container: Container, identity: ArtifactIdentity, after = "", limit = 100) {
    const resolved = await resolve(container, identity);
    let items: { path: string; size: number; mediaType: string }[];
    if (resolved.scope === "app") {
      const page = await artifacts.storage(resolved.id, { area: "files", operation: "list", after, limit }, identity);
      if (!page.items) throw new ArtifactError("INVALID_INPUT");
      items = page.items.map((item) => ({ path: item.key, size: item.bytes, mediaType: item.mediaType }));
    } else if (resolved.scope === "project") {
      items = await aiProjects.listFiles(resolved.id, identity.accessSubject, { after, limit });
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
    if (resolved.scope === "app") {
      const result = await artifacts.storage(resolved.id, { area: "files", operation: "read", key: location.path }, identity);
      if (result.item?.data) file = { bytes: result.item.data, mediaType: result.item.mediaType, version: String(result.item.version) };
    } else if (resolved.scope === "project") {
      const result = await aiProjects.readFileByPath(resolved.id, location.path, identity.accessSubject);
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
    const file = await studioFiles.read(reference, identity);
    if (!file || file.version !== reference.version) throw new ArtifactError("CONFLICT");
    return file;
  },
  async destination(location: AiFileLocation, expectedVersion: string | null, identity: ArtifactIdentity) {
    const resolved = await resolve(location, identity, true);
    const current = await studioFiles.read({ ...location, id: resolved.id }, identity);
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
    const target = await studioFiles.destination(destination, expectedVersion, identity);
    const file = await studioFiles.readReference(source, identity);
    signal.throwIfAborted();
    let version: string;
    try {
      if (target.scope === "app") {
        const result = await artifacts.storage(
          target.id,
          { area: "files", operation: "write", key: destination.path, mediaType: file.mediaType },
          identity,
          false,
          file.bytes,
          { version: numericVersion(expectedVersion) },
        );
        if (!result.version) throw new ArtifactError("CONFLICT");
        version = String(result.version);
      } else if (target.scope === "project") {
        const result = await aiProjects.writeFile(target.id, identity.accessSubject, {
          path: destination.path,
          mediaType: file.mediaType,
          bytes: file.bytes,
          expectedVersion,
        });
        if (!result) throw new ArtifactError("ACCESS_DENIED");
        version = aiFileContentVersion({ ...result, bytes: file.bytes });
      } else {
        const result = await writeAiConversationFile({
          conversationId: target.id,
          ownerUserId: user(identity).id,
          path: destination.path,
          mediaType: file.mediaType,
          bytes: file.bytes,
          expectedVersion,
        });
        version = aiFileContentVersion({ ...result, bytes: file.bytes, id: `${target.id}:${result.path}:${result.version}` });
      }
    } catch (error) {
      if (error instanceof AiFileVersionConflict) throw new ArtifactError("CONFLICT");
      throw error;
    }
    return {
      reference: { scope: target.scope, id: target.id, path: destination.path, version },
      size: file.bytes.byteLength,
      mediaType: file.mediaType,
    };
  },
};

import { studioFiles } from "./file-transfer";
import { readBinaryResponse } from "./binary";
import { ArtifactCompileError, sourceActions } from "./actions";
import { artifactDatabase, DatabaseError } from "./database";
import { AiFileWriteError, CODE_SOURCE_TOOLS, createAiConversationArtifact, AI_FILES_MAX_FILE_BYTES_DEFAULT } from "@k2b/cloud/ai";
import { CAPABILITY_MAX_RESULT_BYTES } from "@k2b/cloud/contracts";
import type { ArtifactIdentity } from "./service";
import { fail, ok } from "@k2b/stdlib";
import { z } from "zod";
import { LIMITS } from "./contracts";
import { artifacts, ArtifactError, user } from "./service";
import { artifactMessages } from "./messages";
import { sourceDiagnostics, sourceManifest } from "./source";
import { accessRevision, resolveDisplayNames } from "@k2b/cloud/server";

export type CodeToolContext = ArtifactIdentity & { locale: string; signal: AbortSignal; review?: boolean; capabilityToken?: string };
const links = (id: string) => ({
  refs: [{ type: "assistant.artifact", id }],
  links: [{ rel: "open" as const, href: `/app/assistant?workspace=${encodeURIComponent(JSON.stringify(["app", id]))}` }],
});
async function result<T>(
  context: CodeToolContext,
  operation: () => Promise<{ data: T; refs?: { type: string; id: string }[]; links?: { rel: "open"; href: string }[] }>,
) {
  try {
    return ok(await operation());
  } catch (error) {
    if (error instanceof ArtifactCompileError || error instanceof AiFileWriteError)
      return fail({ code: error.code, status: error.code === "CONFLICT" ? 409 as const : 400 as const, message: error.message });
    if (error instanceof DatabaseError) {
      const t = artifactMessages.resolve([context.locale]).t;
      const message =
        error.code === "DB_UNREACHABLE"
          ? t.DB_UNREACHABLE
          : error.code === "DB_TIMEOUT"
            ? t.DB_TIMEOUT
            : error.code === "DB_AUTH_FAILED"
              ? t.DB_AUTH_FAILED
              : error.code === "DB_NOT_CONFIGURED"
                ? t.DB_NOT_CONFIGURED
                : error.code === "DB_NOT_CONNECTED"
                  ? t.DB_NOT_CONNECTED
                  : error.code === "DB_RESULT_TOO_LARGE"
                    ? t.DB_RESULT_TOO_LARGE
                    : error.code;
      return fail({ code: error.code, status: error.status === 502 ? 500 : error.status, message });
    }
    if (error instanceof ArtifactError)
      return fail({
        code: error.code,
        status:
          error.code === "ACCESS_DENIED"
            ? (403 as const)
            : error.code === "NOT_FOUND"
              ? (404 as const)
              : error.code === "CONFLICT"
                ? (409 as const)
                : (400 as const),
        message: artifactMessages.resolve([context.locale]).t[error.code],
      });
    if (error instanceof z.ZodError)
      return fail({ code: "INVALID_INPUT", status: 400 as const, message: artifactMessages.resolve([context.locale]).t.INVALID_INPUT });
    throw error;
  }
}

export const artifactCodeHandlers = {
  code_files: (input, context) => result(context, async () => ({ data: await studioFiles.list(input, context, input.after, input.limit) })),
  code_file_stat: ({ file }, context) => result(context, async () => {
    const found = await studioFiles.read(file, context);
    return { data: found ? { exists: true, reference: found.reference, size: found.bytes.byteLength, mediaType: found.mediaType } : { exists: false } };
  }),
  code_file_copy: (input, context) => result<unknown>(context, async () => {
    if (context.review) {
      const target = await studioFiles.destination(input.destination, input.expectedVersion, context);
      const source = await studioFiles.readReference(input.source, context);
      return { data: { message: `Copy ${input.source.path} (${source.bytes.byteLength} bytes) from ${input.source.scope} “${source.title}” (${source.reference.id}) to ${target.scope} “${target.title}” (${target.id}) at ${input.destination.path}. ${input.expectedVersion === null ? "Create a new file." : "Replace the reviewed destination file."} Files in Apps and Projects can be read by other authorized users. No other files are transferred.` } };
    }
    return { data: await studioFiles.copy(input.source, input.destination, input.expectedVersion, context, context.signal) };
  }),
  code_database_export: ({ id, path }, context) => result(context, async () => {
    if (!context.conversationId) throw new ArtifactError("ACCESS_DENIED");
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(30000)]);
    const response = await artifactDatabase.export(id, context, signal);
    const bytes = await readBinaryResponse(response, AI_FILES_MAX_FILE_BYTES_DEFAULT);
    signal.throwIfAborted();
    const resource = await artifacts.get(id, context);
    if (resource.permission !== "admin") throw new ArtifactError("ACCESS_DENIED");
    return { data: await createAiConversationArtifact({ conversationId: context.conversationId, ownerUserId: user(context).id,
      path, bytes, mediaType: "application/vnd.sqlite3", producerCallKey: `database-export:${crypto.randomUUID()}` }) };
  }),
  code_manage_read: ({ id }, context) => result(context, async () => ({ data: await artifacts.managementState(id, context) })),
  code_delete: (input, context) => result<unknown>(context, async () => {
    const state = await artifacts.managementState(input.id, context);
    if (state.managementRevision !== input.expectedManagementRevision) throw new ArtifactError("CONFLICT");
    if (context.review) return { data: { message: `Permanently delete App “${state.title}” (${input.id}), all source history, publications, grants, ${state.files} shared files, ${state.kv} JSON keys and its database (connected: ${state.databaseConnected}). Database physical deletion is queued. This cannot be undone.` } };
    return { data: await artifacts.remove(input.id, context, input.expectedManagementRevision) };
  }),
  code_database_read: ({ id }, context) => result(context, async () => {
    const state = await artifactDatabase.status(id, context, context.signal);
    return { data: { configured: state.configured, connected: state.connected, generation: state.generation, dataRevision: state.dataRevision, tables: state.overview?.schema.tables ?? null, unavailable: state.unavailable } };
  }),
  code_database_clear: (input, context) => result<unknown>(context, async () => {
    const state = await artifactDatabase.status(input.id, context, context.signal);
    if (state.generation !== input.expectedGeneration || state.dataRevision !== input.expectedDataRevision) throw new ArtifactError("CONFLICT");
    if (context.review) {
      const resource = await artifacts.get(input.id, context);
      return { data: { message: `Permanently clear all rows in App “${resource.title}” (${input.id}). Tables and schema stay intact. Source, publications, files and JSON storage are preserved. A failure may leave some tables cleared.` } };
    }
    return { data: await artifactDatabase.clear(input.id, input.expectedGeneration, input.expectedDataRevision, context, context.signal) };
  }),
  code_database_reset: (input, context) => result<unknown>(context, async () => {
    const state = await artifactDatabase.status(input.id, context, context.signal);
    if (state.generation !== input.expectedGeneration || state.dataRevision !== input.expectedDataRevision) throw new ArtifactError("CONFLICT");
    if (context.review) {
      const resource = await artifacts.get(input.id, context);
      return { data: { message: `Permanently discard the entire database of App “${resource.title}” (${input.id}), including all tables and data. Source, publications, files and JSON storage are preserved. Physical deletion is queued; the next connection starts empty.` } };
    }
    const data = await artifactDatabase.reset(input.id, input.expectedGeneration, context, input.expectedDataRevision);
    return { data: { ...data, databaseCleanupQueued: input.expectedGeneration !== null } };
  }),
  code_storage_list: (input, context) => result(context, async () => {
    const state = await artifacts.storageState(input.id, context);
    const page = await artifacts.storage(input.id, { operation: "list", area: input.area, after: input.after, limit: input.limit }, context, true, undefined, { storageRevision: state.storageRevision });
    if (!page.items) throw new ArtifactError("INVALID_INPUT");
    return { data: { ...state, items: page.items, nextAfter: page.items.length === input.limit ? page.items.at(-1)!.key : null } };
  }),
  code_storage_delete: (input, context) => result<unknown>(context, async () => {
    const state = await artifacts.storageState(input.id, context);
    if (state.storageRevision !== input.expectedStorageRevision) throw new ArtifactError("CONFLICT");
    if (context.review) return { data: { message: `Permanently delete ${input.key ? JSON.stringify(input.key) : "all entries"} from ${input.area} storage of App “${state.title}” (${input.id}).\nCurrent storage: ${JSON.stringify(state.areas)}\nSource, publications and database are preserved.` } };
    const data = input.key && input.area !== "all"
      ? await artifacts.storage(input.id, { operation: "delete", area: input.area, key: input.key }, context, true, undefined, { storageRevision: input.expectedStorageRevision })
      : await artifacts.clearStorage(input.id, input.area, context, input.expectedStorageRevision);
    return { data };
  }),
  code_access_read: ({ id }, context) => result(context, async () => {
    const grants = await artifacts.access(id, context);
    return { data: { id, accessRevision: accessRevision(grants), levels: ["read", "admin"], principalTypes: ["user", "group", "authenticated", "public"], publicLevels: ["read"], runnerHref: `/app/assistant/apps/${id}/run`, grants } };
  }),
  code_access_change: (input, context) => result<unknown>(context, async () => {
    const grants = await artifacts.access(input.id, context);
    if (accessRevision(grants) !== input.expectedAccessRevision) throw new ArtifactError("CONFLICT");
    const previous = input.accessId ? grants.find(grant => grant.id === input.accessId) : undefined;
    if (input.accessId && !previous) throw new ArtifactError("NOT_FOUND");
    const principal = previous?.principal ?? input.principal;
    if (!principal) throw new ArtifactError("INVALID_INPUT");
    if (principal.type === "public" && input.permission !== null && input.permission !== "read") throw new ArtifactError("PUBLIC_READ_ONLY");
    if (context.review) {
      const resource = await artifacts.get(input.id, context);
      const [recipient] = await resolveDisplayNames([{ principal }]);
      return { data: { message: `Change access to App “${resource.title}” (${input.id}).\nRecipient: ${recipient!.displayName} — ${JSON.stringify(principal)}\nBefore: ${previous?.permission ?? "No grant"}\nAfter: ${input.permission ?? "Remove grant"}\nThis does not change access to any Skill.${principal.type === "public" ? " Public access runs only the published App without database, server files/KV, secrets or protected Cloud actions. Public Manage is forbidden." : ""}` } };
    }
    if (input.principal && input.permission) await artifacts.grant(input.id, input.principal, input.permission, context, input.expectedAccessRevision);
    else if (input.accessId) await artifacts.changeGrant(input.id, input.accessId, input.permission, context, input.expectedAccessRevision);
    else throw new ArtifactError("INVALID_INPUT");
    return { data: { changed: true } };
  }),
  code_unpublish: ({ id, expectedPublishedVersion }, context) => result<unknown>(context, async () => {
    const state = await artifacts.managementState(id, context);
    if (state.publishedVersion !== expectedPublishedVersion) throw new ArtifactError("CONFLICT");
    if (context.review) return { data: { message: `Withdraw App “${state.title}” (${id}), publication ${expectedPublishedVersion}. Users with Use access can no longer start its GUI or actions. Source, history and data remain.` } };
    return { data: await artifacts.unpublish(id, context, expectedPublishedVersion) };
  }),
  code_actions: ({ id, draft }, context) => result(context, async () => {
    const bundle = await artifacts.get(id, context, undefined, !draft);
    if (draft && bundle.permission !== "admin") throw new ArtifactError("ACCESS_DENIED");
    return { data: { id, publishedVersion: bundle.publishedVersion, ...(draft ? { revision: bundle.sourceRevision } : {}), actions: sourceActions(bundle.source) }, ...links(id) };
  }),
  code_sql: ({ id, sql, params }, context) =>
    result(context, async () => {
      const data = await artifactDatabase.call(id, { operation: "query", sql, params }, context, context.signal);
      if (new TextEncoder().encode(JSON.stringify({ data })).byteLength > CAPABILITY_MAX_RESULT_BYTES)
        throw new DatabaseError("DB_RESULT_TOO_LARGE");
      return { data };
    }),
  code_versions: ({ id, page }, context) => result(context, async () => ({ data: await artifacts.versions(id, context, page) })),
  code_list: ({ page, q }, context) =>
    result(context, async () => {
      const result = await artifacts.list(context, page, q);
      return {
        data: {
          ...result,
          items: result.items.map(({ id, kind, title, description, permission, publishedVersion, publishedRevision }) => ({
            id,
              title,
            description,
            permission,
            publishedRevision,
            publishedVersion,
          })),
        },
      };
    }),
  code_read: ({ id, path, offset, revision }, context) =>
    result<unknown>(context, async () => {
      const bundle = await artifacts.get(id, context, revision);
      if (!path) return { data: sourceManifest(bundle), ...links(id) };
      const file = bundle.source.files.find((file) => file.path === path);
      if (!file) throw new ArtifactError("NOT_FOUND");
      if (offset > file.content.length) throw new ArtifactError("INVALID_INPUT");
      const end = Math.min(file.content.length, offset + LIMITS.text);
      return {
        data: {
          id,
          path,
          content: file.content.slice(offset, end),
          nextOffset: end < file.content.length ? end : null,
          complete: end === file.content.length,
        },
      };
    }),
  code_history: ({ id, page }, context) => result(context, async () => ({ data: await artifacts.history(id, context, page) })),
  code_fork: ({ id }, context) =>
    result(context, async () => {
      const copy = await artifacts.fork(id, context);
      return { data: sourceManifest(copy), ...links(copy.id) };
    }),
  code_publish: ({ id, expectedRevision, note }, context) =>
    result(context, async () => ({ data: await artifacts.publish(id, expectedRevision, context, note), ...links(id) })),
  code_restore: ({ id, version, expectedRevision }, context) =>
    result(context, async () => ({ data: sourceManifest(await artifacts.restore(id, version, expectedRevision, context)), ...links(id) })),
  code_update: ({ id, ...patch }, context) =>
    result(context, async () => ({ data: sourceManifest(await artifacts.metadata(id, patch, context)), ...links(id) })),
  code_create: ({ title, description, icon }, context) =>
    result(context, async () => {
      const created = await artifacts.create(
        {
          title,
          description,
          icon,
          source: { entry: "main.ts", files: [{ path: "main.ts", content: "export default () => {};\n" }] },
        },
        context,
      );
      return { data: sourceManifest(created), ...links(created.id) };
    }),
  code_write: ({ id, files, expectedRevision, entry }, context) =>
    result<unknown>(context, async () => {
      // Authorize the destination before loading any source data.
      const current = await artifacts.get(id, context);
      if (current.permission !== "admin") throw new ArtifactError("ACCESS_DENIED");
      if (current.revision !== expectedRevision) throw new ArtifactError("CONFLICT");
      const resolved = [];
      for (const file of files) {
        if ("content" in file) { resolved.push(file); continue; }
        const data = await studioFiles.readReference(file.fromFile, context);
        if (data.bytes.byteLength > LIMITS.fileBytes) throw new ArtifactError("INVALID_INPUT");
        let content: string;
        try { content = new TextDecoder("utf-8", { fatal: true }).decode(data.bytes); }
        catch { throw new ArtifactError("INVALID_INPUT"); }
        resolved.push({ path: file.path, content });
      }
      if (context.review) return { data: { message: `Import the reviewed files into source of App “${current.title}” (${id}): ${files.filter(file => "fromFile" in file).map(file => JSON.stringify(file)).join(", ")}. Existing source paths in this batch are replaced. Imported data becomes App source and may be shared or published with it.` } };
      const saved = await artifacts.writeFiles(id, { files: resolved, expectedRevision, entry }, context);
      return { data: { ...sourceManifest(saved), saved: true, imported: files.filter(file => "fromFile" in file), diagnostics: await sourceDiagnostics(saved.source) }, ...links(id) };
    }),
  code_remove: ({ id, path }, context) =>
    result(context, async () => {
      const saved = await artifacts.writeFile(id, path, null, context);
      return { data: { id, path, removed: true, diagnostics: await sourceDiagnostics(saved.source) } };
    }),
} satisfies {
  [K in keyof typeof CODE_SOURCE_TOOLS]: (
    input: z.output<(typeof CODE_SOURCE_TOOLS)[K]["input"]>,
    context: CodeToolContext,
  ) => Promise<unknown>;
};

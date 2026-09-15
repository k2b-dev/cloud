import { sourceActions } from "./actions";
import { artifactDatabase, DatabaseError } from "./database";
import { CODE_SOURCE_TOOLS, readAiConversationFile } from "@k2b/cloud/ai";
import { CAPABILITY_MAX_RESULT_BYTES } from "@k2b/cloud/contracts";
import type { ArtifactIdentity } from "./service";
import { fail, ok } from "@k2b/stdlib";
import { z } from "zod";
import { LIMITS } from "./contracts";
import { artifacts, ArtifactError, user } from "./service";
import { artifactMessages } from "./messages";
import { sourceDiagnostics, sourceManifest } from "./source";
import { accessRevision } from "@k2b/cloud/server";

export type CodeToolContext = ArtifactIdentity & { locale: string; signal: AbortSignal; review?: boolean };
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
  code_access_read: ({ id }, context) => result(context, async () => {
    const grants = await artifacts.access(id, context);
    return { data: { id, accessRevision: accessRevision(grants), levels: ["read", "admin"], principalTypes: ["user", "group", "authenticated"], grants } };
  }),
  code_access_change: (input, context) => result<unknown>(context, async () => {
    if (input.principal?.type === "public" || input.principal?.type === "service_account") throw new ArtifactError("INVALID_INPUT");
    const grants = await artifacts.access(input.id, context);
    if (accessRevision(grants) !== input.expectedAccessRevision) throw new ArtifactError("CONFLICT");
    const previous = input.accessId ? grants.find(grant => grant.id === input.accessId) : undefined;
    if (input.accessId && !previous) throw new ArtifactError("NOT_FOUND");
    if (context.review) {
      const resource = await artifacts.get(input.id, context);
      return { data: { message: `Change access to App “${resource.title}” (${input.id}).\nRecipient: ${JSON.stringify(previous?.principal ?? input.principal)}\nBefore: ${previous?.permission ?? "No grant"}\nAfter: ${input.permission ?? "Remove grant"}\nThis does not change access to any Skill.` } };
    }
    if (input.principal && input.permission) await artifacts.grant(input.id, input.principal, input.permission, context, input.expectedAccessRevision);
    else if (input.accessId) await artifacts.changeGrant(input.id, input.accessId, input.permission, context, input.expectedAccessRevision);
    else throw new ArtifactError("INVALID_INPUT");
    return { data: { changed: true } };
  }),
  code_actions: ({ id, draft }, context) => result(context, async () => {
    const bundle = await artifacts.get(id, context, undefined, !draft);
    if (draft && bundle.permission !== "admin") throw new ArtifactError("ACCESS_DENIED");
    return { data: { id, publishedVersion: bundle.publishedVersion, revision: bundle.sourceRevision, actions: sourceActions(bundle.source) }, ...links(id) };
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
          items: result.items.map(({ id, kind, title, description, permission, publishedRevision }) => ({
            id,
              title,
            description,
            permission,
            publishedRevision,
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
    result(context, async () => {
      // Authorize the destination before loading any source data.
      const current = await artifacts.get(id, context);
      if (current.permission !== "admin") throw new ArtifactError("ACCESS_DENIED");
      if (current.revision !== expectedRevision) throw new ArtifactError("CONFLICT");
      const resolved = [];
      for (const file of files) {
        if ("content" in file) { resolved.push(file); continue; }
        if (!context.conversationId) throw new ArtifactError("ACCESS_DENIED");
        const data = await readAiConversationFile({ conversationId: context.conversationId, ownerUserId: user(context).id, ...file.fromChatFile });
        if (!data) throw new ArtifactError("CONFLICT");
        if (data.bytes.byteLength > LIMITS.fileBytes) throw new ArtifactError("INVALID_INPUT");
        let content: string;
        try { content = new TextDecoder("utf-8", { fatal: true }).decode(data.bytes); }
        catch { throw new ArtifactError("INVALID_INPUT"); }
        resolved.push({ path: file.path, content });
      }
      const saved = await artifacts.writeFiles(id, { files: resolved, expectedRevision, entry }, context);
      return { data: { ...sourceManifest(saved), saved: true, imported: files.filter(file => "fromChatFile" in file), diagnostics: await sourceDiagnostics(saved.source) }, ...links(id) };
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

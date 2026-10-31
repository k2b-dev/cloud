import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { z } from "zod";
import { readBoundedJson } from "../_internal/bounded-json";
import { resolveCapabilityManifestPresentation } from "../_internal/capabilities";
import { withCapabilityRequestTimeout } from "../_internal/capability-timeout";
import { getCapability } from "../_internal/registry";
import { invokeCodeAccess } from "../code/access-core";
import {
  CAPABILITY_MAX_RESULT_BYTES,
  CloudResourceReaderViewSchema,
  CloudResourceRefSchema,
  capabilityResultSchema,
  cloudResourceRefAppId,
  resolveCapabilityResourceReader,
} from "../contracts/capabilities";
import {
  type CodeAccessAccount,
  CodeAccessAccountsDataSchema,
  CodeAccessAccountsInputSchema,
  CodeAccessRemoveDataSchema,
  CodeAccessRemoveRequestSchema,
} from "../contracts/code-access";
import { sql } from "../runtime/clients";
import { type AuthContext, auth, getLocale, type RequestAuthority } from "../server";
import { toPgUuidArray } from "../services/postgres";
import { dispatchCapability } from "./capabilities";

type Owner = { kind: "app"; appId: string } | { kind: "resource"; ref: z.infer<typeof CloudResourceRefSchema> };

/** Code account names are derived from their owner: `code:app:<appId>` or `code:<type>:<id>` (modell 4.2). */
export const codeAccountOwner = (name: string): Owner | null => {
  const match = /^code:([^:]+):(.+)$/.exec(name);
  if (!match) return null;
  const [, type = "", id = ""] = match;
  if (type === "app") return /^[a-z][a-z0-9-]*$/.test(id) ? { kind: "app", appId: id } : null;
  const ref = CloudResourceRefSchema.safeParse({ type, id });
  return ref.success ? { kind: "resource", ref: ref.data } : null;
};

type Context = { request: Request; authority: RequestAuthority; locale?: string };
export type CodeAccessRouteDependencies = {
  accounts?: (ids: string[]) => Promise<{ id: string; name: string }[]>;
  getCapability?: typeof getCapability;
  dispatch?: typeof dispatchCapability;
  invoke?: typeof invokeCodeAccess;
};

const codeAccounts = async (ids: string[]) =>
  sql<{ id: string; name: string }[]>`
    SELECT id, name FROM auth.service_accounts WHERE id = ANY(${toPgUuidArray(ids)}::uuid[]) AND kind = 'code'`;

type OwnerApp = NonNullable<Awaited<ReturnType<typeof getCapability>>>;
/** The owner's current title through its canonical reader, under the person's own authority; never cached. */
const readOwnerTitle = async (owner: Owner, app: OwnerApp, context: Context, dependencies: CodeAccessRouteDependencies) => {
  if (owner.kind === "app") return app.appName;
  const manifest = context.locale ? resolveCapabilityManifestPresentation(app.manifest, app.presentation, context.locale) : app.manifest;
  const reader = resolveCapabilityResourceReader(manifest, owner.ref);
  if (!reader) return null;
  const response = await (dependencies.dispatch ?? dispatchCapability)({
    request: context.request,
    authority: context.authority,
    locale: context.locale,
    origin: "http",
    kind: "queries",
    appId: app.appId,
    capabilityId: reader.localId,
    input: { id: owner.ref.id },
  });
  if (!response.ok) return null;
  const body = await readBoundedJson(response, CAPABILITY_MAX_RESULT_BYTES, context.request.signal);
  if (!body.ok) return null;
  const result = capabilityResultSchema(z.object({ view: CloudResourceReaderViewSchema }), { consumer: true }).safeParse(body.data);
  return result.success ? result.data.data.view.title : null;
};

// A share list rarely names more than a few Code accounts; bound the parallel reader calls all the same.
const READER_CONCURRENCY = 8;

/** Unknown, hidden and unreadable accounts all come back with a null owner title. */
export const describeCodeAccessAccounts = async (
  ids: readonly string[],
  context: Context,
  dependencies: CodeAccessRouteDependencies = {},
): Promise<CodeAccessAccount[]> => {
  const unique = [...new Set(ids)];
  const names = new Map((await (dependencies.accounts ?? codeAccounts)(unique)).map((row) => [row.id, row.name]));
  const items: CodeAccessAccount[] = [];
  for (let start = 0; start < unique.length; start += READER_CONCURRENCY) {
    context.request.signal.throwIfAborted();
    items.push(
      ...(await Promise.all(
        unique.slice(start, start + READER_CONCURRENCY).map(async (id): Promise<CodeAccessAccount> => {
          const name = names.get(id);
          const owner = name ? codeAccountOwner(name) : null;
          if (!owner) return { id, ownerTitle: null, appId: null, icon: null, accent: null };
          const appId = owner.kind === "app" ? owner.appId : cloudResourceRefAppId(owner.ref);
          const app = await (dependencies.getCapability ?? getCapability)(appId).catch(() => null);
          if (!app || app.appId !== appId) return { id, ownerTitle: null, appId: null, icon: null, accent: null };
          const ownerTitle = await readOwnerTitle(owner, app, context, dependencies).catch(() => null);
          return { id, ownerTitle: ownerTitle?.slice(0, 500) || null, appId, icon: app.appIcon || null, accent: app.appAccent ?? null };
        }),
      )),
    );
  }
  return items;
};

const ErrorBody = z.object({ code: z.string(), message: z.string() });
// Bound malformed JSON before parsing: UUIDs and their separators, with room for whitespace.
const ACCOUNTS_MAX_BYTES = 64 * 1024;
const REMOVE_MAX_BYTES = 1024;

/**
 * Core routes behind the shared rights editor's "Code with access" section. Presentation reads owners
 * under the person's own authority; removal admits exactly one generated `code.access.rm` at the target,
 * which decides itself whether the person manages the target.
 */
export const createCodeAccessRoutes = (dependencies: CodeAccessRouteDependencies = {}) =>
  new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.header("Cache-Control", "private, no-store");
      await next();
    })
    .post(
      "/accounts",
      auth.readOnly,
      auth.requireRole("authenticated"),
      describeRoute({
        tags: ["Resources"],
        summary: "Present Code accounts from a share list with their owners' current titles",
        requestBody: { required: true, content: { "application/json": { schema: resolver(CodeAccessAccountsInputSchema) } } },
        responses: {
          200: { description: "Code accounts", content: { "application/json": { schema: resolver(CodeAccessAccountsDataSchema) } } },
          400: { description: "Invalid request", content: { "application/json": { schema: resolver(ErrorBody) } } },
        },
      }),
      async (c) => {
        const body = await readBoundedJson(c.req.raw, ACCOUNTS_MAX_BYTES, c.req.raw.signal);
        const input = body.ok ? CodeAccessAccountsInputSchema.safeParse(body.data) : null;
        if (!input?.success) return c.json({ code: "VALIDATION_FAILED", message: "Invalid Code account list" }, 400);
        const items = await withCapabilityRequestTimeout(c, "query", () =>
          describeCodeAccessAccounts(
            input.data.ids,
            { request: c.req.raw, authority: auth.getAuthority(c), locale: getLocale(c) },
            dependencies,
          ),
        );
        return c.json({ items }, 200);
      },
    )
    .post(
      "/remove",
      auth.requireRole("authenticated"),
      describeRoute({
        tags: ["Resources"],
        summary: "Remove one Code grant at its target through the target's code.access.rm",
        requestBody: { required: true, content: { "application/json": { schema: resolver(CodeAccessRemoveRequestSchema) } } },
        responses: {
          200: { description: "Removal result", content: { "application/json": { schema: resolver(CodeAccessRemoveDataSchema) } } },
          400: { description: "Invalid request", content: { "application/json": { schema: resolver(ErrorBody) } } },
          403: { description: "Not allowed", content: { "application/json": { schema: resolver(ErrorBody) } } },
        },
      }),
      async (c) => {
        const body = await readBoundedJson(c.req.raw, REMOVE_MAX_BYTES, c.req.raw.signal);
        const input = body.ok ? CodeAccessRemoveRequestSchema.safeParse(body.data) : null;
        if (!input?.success) return c.json({ code: "VALIDATION_FAILED", message: "Invalid Code access removal" }, 400);
        const response = await (dependencies.invoke ?? invokeCodeAccess)({
          request: c.req.raw,
          appId: input.data.appId,
          operation: "rm",
          input: { grantId: input.data.grantId },
          authority: auth.getAuthority(c),
          locale: getLocale(c),
        });
        const result = await readBoundedJson(response, CAPABILITY_MAX_RESULT_BYTES, c.req.raw.signal);
        if (response.ok) {
          const parsed = result.ok ? capabilityResultSchema(CodeAccessRemoveDataSchema, { consumer: true }).safeParse(result.data) : null;
          if (parsed?.success) return c.json(parsed.data.data, 200);
          return c.json({ code: "INVALID_APP_RESPONSE", message: "The application returned an invalid removal result" }, 502);
        }
        const error = result.ok ? ErrorBody.safeParse(result.data) : null;
        const status = [400, 403, 404, 409, 429, 502, 503, 504].includes(response.status) ? response.status : 502;
        return c.json(
          error?.success
            ? { code: error.data.code, message: error.data.message }
            : { code: "UNAVAILABLE", message: "Code access removal failed" },
          status as 400 | 403 | 404 | 409 | 429 | 502 | 503 | 504,
        );
      },
    );

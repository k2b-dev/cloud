import { cliAmbiguityText, localizeCloudCliText } from "@k2b/cloud/cli";
import { ErrorResponseSchema } from "@k2b/cloud/contracts";
import { type AuthContext, auth, getLocale, jsonResponse, respond } from "@k2b/cloud/server";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { ShortIdSchema } from "../contracts";
import { gridsService } from "../service";
import { resolveStoredPublicId } from "../service/public-resources";
import type { Base, Table } from "../service/types";
import { apiMessages } from "./messages";
import { currentActorViewer, currentResourceBoundBaseId, gateAt, gateCredentialScope } from "./permissions";
import { PublicBaseSchema, PublicTableSchema, toPublicBase, toPublicTable } from "./public-dto";
import { v } from "./validator";

/** Base and table names are at most 200 characters; see CreateBaseSchema and CreateTableSchema. */
const NameOrIdSchema = z.string().min(1).max(200);

/** An exact name lists at most this many candidates in the ambiguity message. */
const MAX_CANDIDATES = 50;

export const ResolveQuerySchema = z
  .object({
    base: NameOrIdSchema.optional(),
    table: NameOrIdSchema.optional(),
    record: ShortIdSchema.optional(),
  })
  .refine((query) => query.base !== undefined || query.table !== undefined || query.record !== undefined, {
    message: "Pass base, table, or record.",
  });

export const PublicResolvedAddressSchema = z.object({
  base: PublicBaseSchema,
  table: PublicTableSchema.nullable(),
  record: z.object({ id: ShortIdSchema }).nullable(),
});

type Failure = { status: 400 | 404 | 409; message: string };
type Step<T> = { ok: true; value: T } | { ok: false; failure: Failure };

const found = <T>(value: T): Step<T> => ({ ok: true, value });
const failed = (status: Failure["status"], message: string): Step<never> => ({ ok: false, failure: { status, message } });

const ambiguous = (
  c: Context<AuthContext>,
  value: string,
  resources: { en: string; de: string },
  candidates: { path: string; id: string }[],
) => failed(409, localizeCloudCliText(getLocale(c), cliAmbiguityText({ value, resources, candidates })));

const canRead = async (c: Context<AuthContext>, baseId: string) => (await gateAt(c, { baseId }, "read")).ok;

/** A base by public ID first, then by exact name among the bases the caller can read. */
const resolveBase = async (c: Context<AuthContext>, ref: string): Promise<Step<Base>> => {
  if (ShortIdSchema.safeParse(ref).success) {
    const byId = await gridsService.base.getByShortId(ref);
    if (byId && (await canRead(c, byId.id))) return found(byId);
  }
  const boundBaseId = currentResourceBoundBaseId(c);
  if (boundBaseId === null) return failed(404, apiMessages(c).baseNotFound);
  const { items } = await gridsService.base.listVisible({
    ...currentActorViewer(c),
    ...(boundBaseId ? { baseId: boundBaseId } : {}),
    name: ref,
    limit: MAX_CANDIDATES,
  });
  if (items.length === 0) return failed(404, apiMessages(c).baseNotFound);
  if (items.length > 1) {
    return ambiguous(
      c,
      ref,
      { en: "bases", de: "Basen" },
      items.map((base) => ({ path: base.name, id: base.shortId })),
    );
  }
  return found(items[0]!);
};

const readableTableById = async (c: Context<AuthContext>, ref: string, baseId?: string) => {
  const table = baseId ? await gridsService.table.getByShortIdForBase(baseId, ref) : await gridsService.table.getByShortId(ref);
  return table && (await canRead(c, table.baseId)) ? table : null;
};

/**
 * A table by public ID or exact name inside the base. A table ID also resolves outside the named base,
 * because IDs always work; a name needs the base.
 */
const resolveTable = async (c: Context<AuthContext>, base: Base | null, ref: string): Promise<Step<{ base: Base; table: Table }>> => {
  const isId = ShortIdSchema.safeParse(ref).success;
  if (base) {
    const inBase = isId ? await readableTableById(c, ref, base.id) : null;
    if (inBase) return found({ base, table: inBase });
    const matches = (await gridsService.table.listByBase(base.id)).filter((table) => table.name === ref);
    if (matches.length > 1) {
      return ambiguous(
        c,
        ref,
        { en: "tables", de: "Tabellen" },
        matches.map((table) => ({ path: `${base.name}:${table.name}`, id: table.shortId })),
      );
    }
    if (matches[0]) return found({ base, table: matches[0] });
  }
  const byId = isId ? await readableTableById(c, ref) : null;
  const owner = byId ? await gridsService.base.get(byId.baseId) : null;
  if (byId && owner) return found({ base: owner, table: byId });
  return failed(404, base ? apiMessages(c).tableNotFound : apiMessages(c).tableNeedsBase);
};

/** A record by public ID, live or in the trash, when the caller can read it. */
const resolveRecord = async (c: Context<AuthContext>, ref: string): Promise<Step<{ base: Base; table: Table }>> => {
  const notFound = failed(404, apiMessages(c).recordNotFound);
  const recordId = await resolveStoredPublicId("record", ref);
  const tableId = recordId ? await gridsService.record.findTableId(recordId, { includeDeleted: true }) : null;
  const table = tableId ? await gridsService.table.get(tableId) : null;
  if (!recordId || !table || !(await canRead(c, table.baseId))) return notFound;
  const visible = await gridsService.record.get(table.id, recordId, {
    viewer: currentActorViewer(c),
    deleted: "include",
    includeRelations: false,
  });
  const base = visible ? await gridsService.base.get(table.baseId) : null;
  return base ? found({ base, table }) : notFound;
};

const resolveAddress = async (
  c: Context<AuthContext>,
  query: z.infer<typeof ResolveQuerySchema>,
): Promise<Step<{ base: Base; table: Table | null; record: string | null }>> => {
  const base = query.base === undefined ? null : await resolveBase(c, query.base);
  if (base && !base.ok) return base;
  const table = query.table === undefined ? null : await resolveTable(c, base?.value ?? null, query.table);
  if (table && !table.ok) return table;

  if (query.record === undefined) {
    if (table) return found({ base: table.value.base, table: table.value.table, record: null });
    if (base) return found({ base: base.value, table: null, record: null });
    return failed(400, apiMessages(c).addressIncomplete);
  }

  const record = await resolveRecord(c, query.record);
  if (!record.ok) return record;
  // A record named together with its base or table must belong to them.
  const outside = (base && base.value.id !== record.value.base.id) || (table && table.value.table.id !== record.value.table.id);
  if (outside) return failed(404, apiMessages(c).recordNotFound);
  return found({ ...record.value, record: query.record });
};

export const createResolveApi = (deps: { requireAuthenticated?: MiddlewareHandler<AuthContext> } = {}) =>
  new Hono<AuthContext>().use(deps.requireAuthenticated ?? auth.requireRole("authenticated")).get(
    "/",
    describeRoute({
      tags: ["Grids:Base"],
      summary: "Resolve a base, table, or record address",
      description:
        "Resolves the parts of a CLI address such as `<base>:<table>/<record>`. IDs always resolve; names are exact. A name that matches several resources fails with 409 and lists every candidate.",
      responses: {
        200: jsonResponse(PublicResolvedAddressSchema, "Resolved address"),
        400: jsonResponse(ErrorResponseSchema, "Invalid query"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Ambiguous name"),
      },
    }),
    v("query", ResolveQuerySchema),
    async (c) => {
      const scopeGate = await gateCredentialScope(c, "read");
      if (!scopeGate.ok) return respond(c, () => Promise.resolve(scopeGate));
      const resolved = await resolveAddress(c, c.req.valid("query"));
      if (!resolved.ok) return c.json({ message: resolved.failure.message }, resolved.failure.status);
      const { base, table, record } = resolved.value;
      return c.json({
        base: toPublicBase(base),
        table: table ? await toPublicTable(table) : null,
        record: record ? { id: record } : null,
      });
    },
  );

export default createResolveApi();

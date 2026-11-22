import { sql } from "@k2b/cloud";
import { getCapabilityCodeReadFacts, invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities/server";
import { CloudResourceReaderViewSchema, CodeCheckedVersionManifestSchema } from "@k2b/cloud/contracts";
import { codeOwnerKindTitle } from "@k2b/cloud/server";
import type { SQL } from "bun";
import { z } from "zod";
import {
  type CodeContext,
  CodeOwnerUnavailableError,
  codePageOwnerPersonName,
  codePermission,
  codePerson,
  isCodePageMember,
  readCodeOwner,
} from "./access";
import type { Code } from "./contracts";
import { describeCodePages } from "./page-links";
import { type CodeRow, mapCode } from "./store";
import {
  CODE_USAGE_CHECKS_MAX,
  CODE_USAGE_CODES_MAX,
  CODE_USAGE_ITEMS_MAX,
  CODE_USAGE_WINDOW_DAYS,
  type CodeUsage,
  type CodeUsageItem,
} from "./usage-contracts";

/** The person may not read the resource, or is no member in their own browser session. */
export class CodeUsageForbidden extends Error {}
/** The resource's reader or the registry did not answer. */
export class CodeUsageUnavailable extends Error {}

/** Same refusals as the route read check (G1): whoever the reader does not answer may not ask about the resource. */
const REFUSED = new Set(["FORBIDDEN", "NOT_FOUND", "APP_ACCESS_DENIED", "VALIDATION_FAILED", "BAD_INPUT"]);
/** Permission checks at once; matches the live engine's owner-reader budget. */
const PERMISSION_CONCURRENCY = 8;
const ReaderDataSchema = z.object({ view: CloudResourceReaderViewSchema });
const clip = (value: string) => value.slice(0, 200);

type Ref = { type: string; id: string };
/** An app-wide Query input field that names a resource of the asked type (`inputRefs`, a type reader's `id`). */
export type CodeUsageInputField = { capability: string; field: string };
export type CodeUsageRow = CodeRow & { manifest: unknown; owner_name: string | null; last_called_at: Date };

/** The input fields of the app's Queries that name a resource of `type`. */
export const codeUsageInputFields = (inputRefs: Readonly<Record<string, Readonly<Record<string, string>>>>, type: string) =>
  Object.entries(inputRefs).flatMap(([capability, fields]) =>
    Object.entries(fields).flatMap(([field, named]) => (named === type ? [{ capability, field }] : [])),
  );

/**
 * One statement: the active Codes (the `CODE_USAGE_CODES_MAX` most recently run) whose runs made a succeeded Query since
 * `since` that read `ref`, with each Code's latest such call. A Query read the resource when its target or one of its
 * refs is the resource, or, for an app-wide Query (no target), when an input field that names this type holds its ID,
 * like the route read check (G1). Actions and failed or running calls do not count. Runs come per Code from
 * `runs_code_history`, calls per run from their primary key; run retention keeps both to thirty days.
 */
export const findCodeUsage = async (
  input: { ref: Ref; fields: readonly CodeUsageInputField[]; since: Date },
  db: SQL = sql,
): Promise<CodeUsageRow[]> => {
  const { ref, since } = input;
  return db<CodeUsageRow[]>`SELECT c.*, v.manifest, COALESCE(NULLIF(u.display_name,''),u.uid) AS owner_name, hit.last_called_at
    FROM (SELECT * FROM code.codes cc WHERE state='active' AND active_version_id IS NOT NULL
      -- The most recently run Codes first (one probe of runs_code_history each), so a busy installation drops idle ones.
      ORDER BY (SELECT max(r.created_at) FROM code.runs r WHERE r.code_id=cc.id) DESC NULLS LAST, id
      LIMIT ${CODE_USAGE_CODES_MAX}) c
    JOIN code.versions v ON v.id=c.active_version_id AND v.code_id=c.id
    LEFT JOIN auth.users u ON c.owner_kind='person' AND u.id=c.owner_user_id
    CROSS JOIN LATERAL (
      SELECT max(k.ended_at) AS last_called_at FROM code.runs r JOIN code.calls k ON k.run_id=r.id
      -- created_at bounds the runs_code_history range: a run lasts minutes, so a day of margin keeps every match.
      WHERE r.code_id=c.id AND r.created_at>=${new Date(since.getTime() - 86_400_000)}
        AND (r.ended_at IS NULL OR r.ended_at>=${since})
        AND k.kind='query' AND k.state='succeeded' AND k.ended_at>=${since}
        AND (
          (k.call->'target'->>'type'=${ref.type} AND k.call->'target'->>'id'=${ref.id})
          OR EXISTS (SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(k.call->'refs')='object' THEN k.call->'refs' ELSE '{}'::jsonb END) e
            WHERE e.value->>'type'=${ref.type} AND e.value->>'id'=${ref.id})
          OR (jsonb_typeof(k.call->'target')='null' AND EXISTS (
            SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(input.fields)}::text::jsonb) AS f(capability text,field text)
            WHERE f.capability=k.call->>'capability' AND jsonb_typeof(k.call->'input'->f.field)='string'
              AND k.call->'input'->>f.field=${ref.id}))
        )
    ) hit
    WHERE hit.last_called_at IS NOT NULL
    ORDER BY hit.last_called_at DESC, c.id`;
};

/** Ask the type's reader as the person, like the route read check: refused → forbidden, no answer → unavailable. */
const readFacts = async (ref: Ref, context: CodeContext) => {
  const appId = ref.type.slice(0, ref.type.indexOf("."));
  const facts = await getCapabilityCodeReadFacts(appId);
  if (!facts) throw new CodeUsageUnavailable(`Capability registry entry unavailable: ${appId}`);
  const reader = facts.typeReaders[ref.type];
  // A resource Cloud cannot check is no resource anyone may ask about.
  if (!reader) throw new CodeUsageForbidden("No reader for this type.");
  const result = await invokeCapabilityWithDataSchema(
    { appId, capabilityId: reader, kind: "query", input: { id: ref.id } },
    ReaderDataSchema,
    { authority: context.authority, locale: context.locale, signal: context.signal },
  );
  if (!result.ok) {
    if (REFUSED.has(result.error.code)) throw new CodeUsageForbidden("The person may not read this resource.");
    throw new CodeUsageUnavailable(`Resource reader unavailable: ${result.error.code}`);
  }
  return facts;
};

/** The owner as the page label and card name it to members (F26): a person's name, an app's name, a resource's name or type. */
const ownerName = async (
  code: Code,
  row: CodeUsageRow,
  context: CodeContext,
  readOwner: () => ReturnType<typeof readCodeOwner>,
): Promise<string | null> => {
  const owner = code.owner;
  if (owner.kind === "person") {
    const name = codePageOwnerPersonName(context.authority, row.owner_name);
    return name ? clip(name) : null;
  }
  if (owner.kind === "resource") {
    // The resource's own name only when its reader names it to this person; otherwise its type, as on the card.
    const read = await readOwner().catch((error: unknown) => {
      if (error instanceof CodeOwnerUnavailableError) return null;
      throw error;
    });
    if (read?.title) return clip(read.title);
  }
  const title = await codeOwnerKindTitle(owner, context.locale);
  return title ? clip(title) : null;
};

/** The entry for an openable Code: a page links to its home page, an automation to its Code page in Core. */
const usageItem = async (
  code: Code,
  row: CodeUsageRow,
  permission: NonNullable<Awaited<ReturnType<typeof codePermission>>>,
  context: CodeContext,
  readOwner: () => ReturnType<typeof readCodeOwner>,
): Promise<CodeUsageItem> => {
  const manifest = CodeCheckedVersionManifestSchema.safeParse(row.manifest);
  const person = codePerson(context);
  const home = manifest.success
    ? describeCodePages(code.id, { id: row.active_version_id ?? "", manifest: manifest.data }, { codeId: code.id, person, permission })
        .homeUrl
    : null;
  return {
    codeId: code.id,
    title: clip(code.title),
    kind: home ? "page" : "automation",
    owner: await ownerName(code, row, context, readOwner),
    lastCalledAt: row.last_called_at.toISOString(),
    href: home ?? `/app/assistant/code/${encodeURIComponent(code.id)}`,
  };
};

/**
 * K1/F4: the Code pages and automations that read one resource in the last thirty days, for a member who may read the
 * resource. Named are only Codes the person may open (`codePermission`, as for reading the Code); every other match
 * is counted in `others` without a name. No per-person or per-call counts. Matching is one statement
 * (`findCodeUsage`); permissions are checked newest first, a few at once, until the item limit is full.
 */
export async function readCodeUsage(
  input: { ref: Ref; now?: Date },
  context: CodeContext,
  deps: { find?: typeof findCodeUsage; permission?: typeof codePermission } = {},
): Promise<CodeUsage> {
  if (!isCodePageMember(context.authority)) throw new CodeUsageForbidden("Members only.");
  const facts = await readFacts(input.ref, context);
  context.signal?.throwIfAborted();
  const since = new Date((input.now ?? new Date()).getTime() - CODE_USAGE_WINDOW_DAYS * 86_400_000);
  const rows = await (deps.find ?? findCodeUsage)({
    ref: input.ref,
    fields: codeUsageInputFields(facts.inputRefs, input.ref.type),
    since,
  });
  const permissionOf = deps.permission ?? codePermission;
  const user = codePerson(context);
  const items: CodeUsageItem[] = [];
  // At most CODE_USAGE_CHECKS_MAX permission checks per request; the unchecked rest only counts in `others` (F4).
  const checked = rows.slice(0, CODE_USAGE_CHECKS_MAX);
  for (let start = 0; start < checked.length && items.length < CODE_USAGE_ITEMS_MAX; start += PERMISSION_CONCURRENCY) {
    context.signal?.throwIfAborted();
    const chunk = await Promise.all(
      checked.slice(start, start + PERMISSION_CONCURRENCY).map(async (row) => {
        const code = mapCode(row, user);
        // One owner read per Code: the permission check and the owner's name ask the same provider.
        let ownerRead: ReturnType<typeof readCodeOwner> | undefined;
        const readOwner = () => {
          ownerRead ??= readCodeOwner(code.owner, context);
          return ownerRead;
        };
        const permission = await permissionOf(code, context, sql, "read", readOwner).catch((error: unknown) => {
          // An owner that cannot answer opens nothing new; existing grants were already kept by the check itself.
          if (error instanceof CodeOwnerUnavailableError) return null;
          throw error;
        });
        return permission ? await usageItem(code, row, permission, context, readOwner) : null;
      }),
    );
    for (const item of chunk) if (item) items.push(item);
  }
  const named = items.slice(0, CODE_USAGE_ITEMS_MAX);
  return { items: named, others: rows.length - named.length, since: since.toISOString() };
}

import { createHash, randomBytes } from "node:crypto";
import { sql } from "@k2b/cloud";
import { type NormalizedCapabilityCall, NormalizedCapabilityCallSchema } from "@k2b/cloud/contracts";
import { buildAccessPrincipalCondition, createAccess, type Principal } from "@k2b/cloud/server";
import type { SQL, TransactionSQL } from "bun";
import type { z } from "zod";
import { type CodeContext, CodeDataError, codePermission, codePerson, readCodeOwner, requireCodePermission } from "./access";
import {
  CODE_INLINE_JSON_BYTES,
  CODE_RESULT_STORAGE_BYTES,
  type Code,
  type CodeCall,
  type CodeOwner,
  CodeOwnerSchema,
  type CodeRun,
  type CodeSourceFiles,
  CodeSourceFilesSchema,
  type CodeVersion,
  type CodeVersionManifest,
  CodeVersionManifestSchema,
  type codeQueryContracts,
} from "./contracts";
import { CODE_SETTINGS, codeSettings } from "./settings";

/** C8/C13 pass their transaction for domain-row operations; admission settings use the registered settings API. */
export type CodeDb = SQL;
export type CodeRow = {
  id: string;
  owner_kind: CodeOwner["kind"];
  owner_user_id: string | null;
  owner_type: string | null;
  owner_id: string | null;
  owner_app_id: string | null;
  title: string;
  service_account_id: string | null;
  state: Code["state"];
  active_version_id: string | null;
  pause_reason?: string | null;
  pause_rows?: string[];
  pause_policy_revision?: number | null;
  created_by: string | null;
  created_at: Date;
};
export const mapCode = (row: CodeRow): Code => ({
  id: row.id,
  owner: CodeOwnerSchema.parse(
    row.owner_kind === "person"
      ? { kind: "person", userId: row.owner_user_id }
      : row.owner_kind === "app"
        ? { kind: "app", appId: row.owner_app_id }
        : { kind: "resource", ref: { type: row.owner_type, id: row.owner_id } },
  ),
  title: row.title,
  serviceAccountId: row.service_account_id,
  state: row.state,
  activeVersionId: row.active_version_id,
  pauseReason: row.pause_reason ?? null,
  pauseRows: row.pause_rows ?? [],
  pausePolicyRevision: row.pause_policy_revision ?? null,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
});
/** Internal row lookup; public callers must use readCode, which authorizes before returning data. */
export const findCode = async (codeId: string, db: CodeDb = sql): Promise<Code | null> => {
  const [row] = await db<CodeRow[]>`SELECT * FROM code.codes WHERE id = ${codeId}`;
  return row ? mapCode(row) : null;
};
export const readCode = async (codeId: string, context: CodeContext) => {
  codePerson(context);
  const code = await findCode(codeId);
  if (!code) throw new CodeDataError("NOT_FOUND", "Code not found.");
  return { code, permission: await requireCodePermission(code, context) };
};
/** Paginate a bounded candidate window. An empty authorized page may still have nextCursor. */
export const listCodes = async (
  input: { owner?: CodeOwner; ownerKind?: CodeOwner["kind"]; limit: number; cursor?: string },
  context: CodeContext,
) => {
  const user = codePerson(context);
  const isAdmin = user.roles.includes("admin");
  const ownOrShared = buildAccessPrincipalCondition({
    subject: context.authority.accessSubject,
    columns: {
      userId: sql`a.user_id`,
      groupId: sql`a.group_id`,
      serviceAccountId: sql`a.service_account_id`,
      authenticatedOnly: sql`a.authenticated_only`,
    },
  });
  const owner = input.owner;
  const kind = owner?.kind ?? input.ownerKind ?? null;
  const userId = owner?.kind === "person" ? owner.userId : null;
  const type = owner?.kind === "resource" ? owner.ref.type : null;
  const id = owner?.kind === "resource" ? owner.ref.id : null;
  const appId = owner?.kind === "app" ? owner.appId : null;
  const rows = await sql<CodeRow[]>`SELECT * FROM code.codes c WHERE
    (${kind}::text IS NULL OR owner_kind = ${kind}) AND (${userId}::uuid IS NULL OR owner_user_id = ${userId}::uuid)
    AND (${type}::text IS NULL OR owner_type = ${type}) AND (${id}::text IS NULL OR owner_id = ${id})
    AND (${appId}::text IS NULL OR owner_app_id = ${appId})
    AND (${isAdmin} OR owner_user_id = ${user.id}::uuid
      OR EXISTS (SELECT 1 FROM code.shares j JOIN auth.access a ON a.id = j.access_id WHERE j.code_id = c.id AND (${ownOrShared}))
      OR ${owner?.kind === "resource" || owner?.kind === "app"})
    AND (${input.cursor ?? null}::text IS NULL OR c.id > ${input.cursor ?? null})
    ORDER BY id LIMIT ${input.limit + 1}`;
  const items = [];
  for (const row of rows.slice(0, input.limit)) {
    const code = mapCode(row);
    const permission = await codePermission(code, context, sql, input.owner ? "read" : "skip");
    if (permission) items.push({ code, permission });
  }
  return {
    items: items.map(({ code, permission }) => ({ ...code, permission })),
    nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.id : null,
  };
};
/** Longest counted window: the person's day in any time zone, with room for a late start. */
const RUN_COUNT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Runs of the caller's own personal Code since a recent moment. */
export const countOwnCodeRuns = async (input: { since: string }, context: CodeContext) => {
  const user = codePerson(context);
  const since = new Date(input.since);
  if (Number.isNaN(since.getTime()) || Date.now() - since.getTime() > RUN_COUNT_WINDOW_MS)
    throw new CodeDataError("BAD_INPUT", "Count runs of at most the last 7 days.");
  const [row] = await sql<{ runs: number; failed: number }[]>`SELECT count(*)::int AS runs,
      count(*) FILTER (WHERE r.state = 'failed')::int AS failed
    FROM code.codes c JOIN code.runs r ON r.code_id = c.id
    WHERE c.owner_kind = 'person' AND c.owner_user_id = ${user.id}::uuid AND r.created_at >= ${since}`;
  return { runs: row?.runs ?? 0, failed: row?.failed ?? 0 };
};
const setting = async (key: keyof typeof CODE_SETTINGS) => {
  const value = await codeSettings.get(key);
  const definition = CODE_SETTINGS[key];
  if (!Number.isSafeInteger(value) || value < definition.min || value > definition.max) throw new Error(`Invalid Code setting: ${key}`);
  return value;
};
const jsonText = (value: unknown, forJsonbOrText = false): string => {
  try {
    const text = JSON.stringify(value, (key, item: unknown) => {
      const invalidText = (value: string) => /[\u0000]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
      if (forJsonbOrText && (invalidText(key) || (typeof item === "string" && invalidText(item))))
        throw new CodeDataError("BAD_INPUT", "Code storage requires valid Unicode without NUL characters.");
      return item;
    });
    if (text === undefined) throw new TypeError("Expected JSON");
    return text;
  } catch (error) {
    if (error instanceof CodeDataError) throw error;
    throw new CodeDataError("BAD_INPUT", "Code storage requires JSON data.");
  }
};
const jsonbBytes = async (text: string, db: CodeDb): Promise<number> => {
  const [row] = await db<{ bytes: number }[]>`SELECT octet_length(${text}::text::jsonb::text) AS bytes`;
  if (!row) throw new Error("JSON size query returned no row");
  return row.bytes;
};
/** Bounded UTF-16 chunks preserve pairs; a one-unit request may return one two-unit pair to make progress. */
export const codeTextChunk = (text: string, offset: number, length: number) => {
  if (offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1] ?? "") && /[\uDC00-\uDFFF]/.test(text[offset] ?? ""))
    throw new CodeDataError("BAD_INPUT", "Offset splits a surrogate pair.");
  let end = Math.min(text.length, offset + length);
  if (end > offset && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "") && /[\uDC00-\uDFFF]/.test(text[end] ?? "")) end--;
  if (end === offset && offset < text.length) end = Math.min(text.length, offset + 2);
  return { text: text.slice(offset, end), nextOffset: end < text.length ? end : null };
};
const bytes = (value: string) => Buffer.byteLength(value, "utf8");
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
/** C16 hashes { entry, files: sorted [path,content] pairs }; unsubmitted C6 snapshots omit entry. UTF-8/SHA-256. */
export const codeSourceHash = (source: CodeSourceFiles, entry?: string): string => {
  const files = Object.keys(source)
    .sort()
    .map((path) => [path, source[path]]);
  return sha256(JSON.stringify(entry === undefined ? files : { entry, files }));
};
export const codeBundleHash = (bundle: string): string => sha256(bundle);

/** Create one owner identity and its credentialless account in one transaction. This grants no target permissions. */
export const createCode = async (input: { owner: CodeOwner; title: string }, context: CodeContext): Promise<Code> => {
  const user = codePerson(context, true);
  const owner = CodeOwnerSchema.parse(input.owner);
  if (owner.kind === "person") {
    if (owner.userId !== user.id) throw new CodeDataError("FORBIDDEN", "Personal Code must be created by its owner.");
  } else {
    const presentation = await readCodeOwner(owner, context);
    if (!presentation) throw new CodeDataError("NOT_FOUND", "Code owner not found.");
    if (!presentation.admin) throw new CodeDataError("FORBIDDEN", "Owner administration required.");
  }
  const title = input.title.trim();
  jsonText(title, true);
  if (!title || title.length > 200) throw new CodeDataError("BAD_INPUT", "Code title must contain 1–200 characters.");
  try {
    return await sql.begin(async (tx) => {
      let accountId: string | null = null;
      if (owner.kind !== "person") {
        const name = owner.kind === "app" ? `code:app:${owner.appId}` : `code:${owner.ref.type}:${owner.ref.id}`;
        const [account] = await tx<
          { id: string }[]
        >`INSERT INTO auth.service_accounts(name,kind,created_by) VALUES(${name},'code',${user.id}::uuid) RETURNING id`;
        if (!account) throw new Error("Code account insert returned no row");
        accountId = account.id;
      }
      const id = `c_${randomBytes(6).toString("hex")}`;
      const [row] = await tx<
        CodeRow[]
      >`INSERT INTO code.codes(id,owner_kind,owner_user_id,owner_type,owner_id,owner_app_id,title,service_account_id,created_by)
        VALUES(${id},${owner.kind},${owner.kind === "person" ? owner.userId : null}::uuid,${owner.kind === "resource" ? owner.ref.type : null},${owner.kind === "resource" ? owner.ref.id : null},${owner.kind === "app" ? owner.appId : null},${title},${accountId}::uuid,${user.id}::uuid) RETURNING *`;
      if (!row) throw new Error("Code insert returned no row");
      return mapCode(row);
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505")
      throw new CodeDataError("CONFLICT", "Owner already has Code.");
    throw error;
  }
};
/** Serialize local share/version edits and recheck grants after acquiring the owner row lock. */
export const lockCodeForEdit = async (codeId: string, context: CodeContext, db: CodeDb): Promise<Code> => {
  const [row] = await db<CodeRow[]>`SELECT * FROM code.codes WHERE id = ${codeId} FOR UPDATE`;
  if (!row) throw new CodeDataError("NOT_FOUND", "Code not found.");
  const code = mapCode(row);
  await requireCodePermission(code, context, true, db);
  return code;
};

/** Common rights-editor backing: share only with persons/groups, never service accounts or wildcard principals. */
export const addCodeShare = async (
  codeId: string,
  principal: Extract<Principal, { type: "user" | "group" }>,
  permission: "editor" | "reader",
  context: CodeContext,
): Promise<string> => {
  codePerson(context, true);
  if (!["user", "group"].includes(principal.type) || !["editor", "reader"].includes(permission))
    throw new CodeDataError("BAD_INPUT", "Invalid Code share.");
  return sql.begin(async (tx) => {
    await lockCodeForEdit(codeId, context, tx);
    const userId = principal.type === "user" ? principal.userId : null;
    const groupId = principal.type === "group" ? principal.groupId : null;
    const [existing] = await tx<{ id: string }[]>`SELECT a.id FROM code.shares j JOIN auth.access a ON a.id=j.access_id
      WHERE j.code_id=${codeId} AND (a.user_id=${userId}::uuid OR a.group_id=${groupId}::uuid)`;
    if (existing) {
      await tx`UPDATE auth.access SET permission=${permission === "editor" ? "write" : "read"}::auth.permission_level WHERE id=${existing.id}::uuid`;
      return existing.id;
    }
    const access = await createAccess({ principal, permission: permission === "editor" ? "write" : "read" }, tx);
    if (!access.ok) throw new CodeDataError("BAD_INPUT", access.error.message);
    await tx`INSERT INTO code.shares(code_id,access_id) VALUES(${codeId},${access.data.id}::uuid)`;
    return access.data.id;
  });
};
export const removeCodeShare = async (codeId: string, accessId: string, context: CodeContext): Promise<void> => {
  codePerson(context, true);
  await sql.begin(async (tx) => {
    await lockCodeForEdit(codeId, context, tx);
    await tx`DELETE FROM code.shares WHERE code_id = ${codeId} AND access_id = ${accessId}::uuid`;
  });
};

type VersionRow = {
  id: string;
  code_id: string;
  number: number;
  source_files: CodeSourceFiles;
  bundle: string;
  source_hash: string;
  bundle_hash: string;
  source_bytes: number;
  bundle_bytes: number;
  manifest: CodeVersionManifest | null;
  created_by: string | null;
  created_at: Date;
};
const mapVersion = (row: VersionRow): CodeVersion => ({
  id: row.id,
  codeId: row.code_id,
  number: row.number,
  files: Object.keys(row.source_files).sort(),
  sourceHash: row.source_hash,
  bundleHash: row.bundle_hash,
  sourceBytes: row.source_bytes,
  bundleBytes: row.bundle_bytes,
  manifestAvailable: row.manifest !== null,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
});
/** Internal storage primitive for C8's transaction; CLI, chat and all push callers must use submitCodeVersion.
 * Save the full executable snapshot once; never fill the manifest by UPDATE.
 */
export const createCodeVersion = async (
  input: {
    codeId: string;
    sourceFiles: CodeSourceFiles;
    bundle: string;
    manifest: CodeVersionManifest | null;
    baseVersionId: string | null;
    /** Original C16 check entry, bound into submitted source hashes. */
    entry?: string;
  },
  context: CodeContext,
  db: CodeDb = sql,
): Promise<CodeVersion> => {
  codePerson(context, true);
  const source = CodeSourceFilesSchema.parse(input.sourceFiles);
  jsonText(source, true);
  jsonText(input.bundle, true);
  const manifest = input.manifest === null ? null : CodeVersionManifestSchema.parse(input.manifest);
  const sourceBytes = Object.entries(source).reduce((total, [path, content]) => total + bytes(path) + bytes(content), 0);
  const bundleBytes = bytes(input.bundle);
  const sourceLimit = await setting("core.code.source_bytes");
  const fileLimit = await setting("core.code.source_files");
  const bundleLimit = await setting("core.code.bundle_bytes");
  const manifestLimit = await setting("core.code.manifest_bytes");
  if (
    Object.keys(source).length < 1 ||
    Object.keys(source).length > fileLimit ||
    sourceBytes > sourceLimit ||
    bundleBytes > bundleLimit ||
    bytes(jsonText(manifest, true)) > manifestLimit
  )
    throw new CodeDataError("BAD_INPUT", "Code version exceeds storage limits.");
  const save = async (tx: CodeDb) => {
    await lockCodeForEdit(input.codeId, context, tx);
    const [latest] = await tx<
      { id: string; number: number }[]
    >`SELECT id,number FROM code.versions WHERE code_id = ${input.codeId} ORDER BY number DESC LIMIT 1`;
    if ((latest?.id ?? null) !== input.baseVersionId) throw new CodeDataError("CONFLICT", "A newer Code version exists.");
    const [row] = await tx<
      VersionRow[]
    >`INSERT INTO code.versions(code_id,number,source_files,bundle,source_hash,bundle_hash,manifest,source_bytes,bundle_bytes,created_by)
      VALUES(${input.codeId},${(latest?.number ?? 0) + 1},${JSON.stringify(source)}::text::jsonb,${input.bundle},${codeSourceHash(source, input.entry)},${codeBundleHash(input.bundle)},${manifest === null ? null : JSON.stringify(manifest)}::text::jsonb,${sourceBytes},${bundleBytes},${codePerson(context).id}::uuid) RETURNING *`;
    if (!row) throw new Error("Version insert returned no row");
    return mapVersion(row);
  };
  return db === sql ? sql.begin(save) : save(db);
};
/** UTF-16 offsets address the returned text; chunks never split a surrogate pair. */
export const readCodeVersion = async (
  input: {
    codeId: string;
    versionId: string;
    content?: { kind: "source"; path: string } | { kind: "bundle" | "manifest" };
    offset: number;
    length: number;
  },
  context: CodeContext,
) => {
  await readCode(input.codeId, context);
  const [row] = await sql<VersionRow[]>`SELECT * FROM code.versions WHERE code_id = ${input.codeId} AND id = ${input.versionId}::uuid`;
  if (!row) throw new CodeDataError("NOT_FOUND", "Code version not found.");
  let text: string | undefined;
  if (input.content?.kind === "bundle") text = row.bundle;
  if (input.content?.kind === "manifest") text = row.manifest === null ? undefined : JSON.stringify(row.manifest);
  if (input.content?.kind === "source")
    text = Object.hasOwn(row.source_files, input.content.path) ? row.source_files[input.content.path] : undefined;
  if (input.content && text === undefined) throw new CodeDataError("NOT_FOUND", "Version content not found.");
  const content = text === undefined ? null : codeTextChunk(text, input.offset, input.length);
  return { version: mapVersion(row), content };
};

type RunRow = {
  id: string;
  code_id: string;
  version_id: string;
  trigger: CodeRun["trigger"];
  entrypoint: string;
  state: CodeRun["state"];
  outcome: string | null;
  input: unknown;
  output: unknown;
  created_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
};
const mapRun = (row: RunRow): CodeRun => ({
  id: row.id,
  codeId: row.code_id,
  versionId: row.version_id,
  trigger: row.trigger,
  entrypoint: row.entrypoint,
  state: row.state,
  outcome: row.outcome,
  createdAt: row.created_at.toISOString(),
  startedAt: row.started_at?.toISOString() ?? null,
  endedAt: row.ended_at?.toISOString() ?? null,
});
/** Public run metadata deliberately has no input, output or calls. */
export const listCodeRuns = async (input: { codeId: string; cursor?: string; limit: number }, context: CodeContext) => {
  await readCode(input.codeId, context);
  const [at, id] = input.cursor?.split("|") ?? [];
  const rows = await sql<
    (RunRow & { cursor_time: string })[]
  >`SELECT id,code_id,version_id,trigger,entrypoint,state,outcome,created_at,started_at,ended_at,
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
    FROM code.runs WHERE code_id = ${input.codeId}
    AND (${at ?? null}::timestamptz IS NULL OR (created_at,id) < (${at ?? null}::timestamptz,${id ?? null}::uuid))
    ORDER BY created_at DESC,id DESC LIMIT ${input.limit + 1}`;
  return {
    items: rows.slice(0, input.limit).map(mapRun),
    nextCursor: rows.length > input.limit ? `${rows[input.limit - 1]!.cursor_time}|${rows[input.limit - 1]!.id}` : null,
  };
};
type CallRow = {
  ordinal: number;
  kind: CodeCall["kind"];
  call: NormalizedCapabilityCall;
  result: CodeCall["result"];
  state: CodeCall["state"];
  started_at: Date;
  ended_at: Date | null;
};
/** Readers receive contents:null. Editors page one bounded call at a time in invocation order. */
export const readCodeRun = async (input: z.input<typeof codeQueryContracts.runRead.input>, context: CodeContext) => {
  const { permission } = await readCode(input.codeId, context);
  const [row] = await sql<
    RunRow[]
  >`SELECT id,code_id,version_id,trigger,entrypoint,state,outcome,created_at,started_at,ended_at FROM code.runs WHERE code_id = ${input.codeId} AND id = ${input.runId}::uuid`;
  if (!row) throw new CodeDataError("NOT_FOUND", "Code run not found.");
  if (permission === "reader") return { run: mapRun(row), contents: null };
  const [payload] = await sql<
    { input: CodeCall["result"]; output: CodeCall["result"] }[]
  >`SELECT input,output FROM code.runs WHERE id = ${input.runId}::uuid`;
  if (!payload) throw new CodeDataError("NOT_FOUND", "Code run not found.");
  const calls = await sql<
    CallRow[]
  >`SELECT * FROM code.calls WHERE run_id = ${input.runId}::uuid AND ordinal > ${input.cursor ?? 0} ORDER BY ordinal LIMIT 2`;
  let selected: string | undefined;
  if (input.content?.kind === "input") selected = jsonText(payload.input);
  if (input.content?.kind === "output") selected = jsonText(payload.output);
  if (input.content?.kind === "call" || input.content?.kind === "result") {
    const [call] = await sql<CallRow[]>`SELECT * FROM code.calls WHERE run_id=${input.runId}::uuid AND ordinal=${input.content.ordinal}`;
    if (!call) throw new CodeDataError("NOT_FOUND", "Code call not found.");
    selected = jsonText(input.content.kind === "call" ? call.call : call.result);
  }
  const inputChunked = bytes(jsonText(payload.input)) > CODE_INLINE_JSON_BYTES;
  const outputChunked = bytes(jsonText(payload.output)) > CODE_INLINE_JSON_BYTES;
  return {
    run: mapRun(row),
    contents: {
      input: inputChunked ? null : payload.input,
      output: outputChunked ? null : payload.output,
      inputChunked,
      outputChunked,
      content: selected === undefined ? null : codeTextChunk(selected, input.offset ?? 0, input.length ?? 16_384),
      calls: calls.slice(0, 1).map((call) => ({
        ordinal: call.ordinal,
        kind: call.kind,
        capability: call.call.capability,
        call: bytes(jsonText(call.call)) > CODE_INLINE_JSON_BYTES ? null : call.call,
        result: bytes(jsonText(call.result)) > CODE_INLINE_JSON_BYTES ? null : call.result,
        callChunked: bytes(jsonText(call.call)) > CODE_INLINE_JSON_BYTES,
        resultChunked: bytes(jsonText(call.result)) > CODE_INLINE_JSON_BYTES,
        state: call.state,
        startedAt: call.started_at.toISOString(),
        endedAt: call.ended_at?.toISOString() ?? null,
      })),
      nextCursor: calls.length > 1 ? calls[0]!.ordinal : null,
    },
  };
};
/** Internal scheduler seam: pins version and admission budgets. C13 owns authorization, leasing and dispatch.
 * entrypoint is the declared handler name, including path handlers; never store concrete URLs, IDs or query strings.
 */
export const insertCodeRun = async (
  input: { codeId: string; versionId: string; trigger: CodeRun["trigger"]; entrypoint: string; input: CodeCall["result"] },
  db: CodeDb = sql,
): Promise<string> => {
  const payloadBytes = await setting("core.code.payload_bytes");
  const callsLimit = await setting("core.code.calls_per_run");
  const encoded = jsonText(input.input, true);
  if ((await jsonbBytes(encoded, db)) > payloadBytes) throw new CodeDataError("BAD_INPUT", "Run input exceeds storage limit.");
  const [row] = await db<
    { id: string }[]
  >`INSERT INTO code.runs(code_id,version_id,trigger,entrypoint,input,payload_bytes,calls_limit) VALUES(${input.codeId},${input.versionId}::uuid,${input.trigger},${input.entrypoint},${encoded}::text::jsonb,${payloadBytes},${callsLimit}) RETURNING id`;
  if (!row) throw new Error("Run insert returned no row");
  return row.id;
};
/** Append the next observation under the run lock. C13 fences the transaction before calling this. */
export const appendCodeCall = async (
  input: { runId: string; kind: CodeCall["kind"]; call: NormalizedCapabilityCall },
  db: TransactionSQL,
): Promise<number> => {
  const call = NormalizedCapabilityCallSchema.parse(input.call);
  const encoded = jsonText(call, true);
  const [run] = await db<
    { payload_bytes: number; calls_limit: number }[]
  >`SELECT payload_bytes,calls_limit FROM code.runs WHERE id=${input.runId}::uuid FOR UPDATE`;
  if (!run) throw new CodeDataError("NOT_FOUND", "Code run not found.");
  if ((await jsonbBytes(encoded, db)) > run.payload_bytes)
    throw new CodeDataError("BAD_INPUT", "Capability call input exceeds storage limit before invocation.");
  const [next] = await db<
    { ordinal: number }[]
  >`SELECT COALESCE(MAX(ordinal),0)+1 AS ordinal FROM code.calls WHERE run_id=${input.runId}::uuid`;
  if (!next || next.ordinal > run.calls_limit)
    throw new CodeDataError("BAD_INPUT", "Code call count exceeds storage limit before invocation.");
  await db`INSERT INTO code.calls(run_id,ordinal,kind,call) VALUES(${input.runId}::uuid,${next.ordinal},${input.kind},${encoded}::text::jsonb)`;
  return next.ordinal;
};
/** Store the bounded result of one observation. No replay behavior is attached to this record. */
export const finishCodeCall = async (
  input: { runId: string; ordinal: number; state: "succeeded" | "failed"; result: CodeCall["result"]; endedAt: Date },
  db: TransactionSQL,
): Promise<void> => {
  // Match settlement's run-before-call lock order, including late authoritative results.
  await db`SELECT id FROM code.runs WHERE id=${input.runId}::uuid FOR UPDATE`;
  let encoded: string;
  try {
    encoded = jsonText(input.result);
  } catch (error) {
    if (!(error instanceof CodeDataError)) throw error;
    encoded = jsonText({ code: "code_result_not_storable", message: error.message });
  }
  // Postgres json preserves exact text, including numeric exponents and escaped NUL.
  const size = bytes(encoded);
  const stored = size > CODE_RESULT_STORAGE_BYTES ? jsonText({ code: "code_result_exceeds_capability_contract", bytes: size }) : encoded;
  const result =
    await db`UPDATE code.calls SET state = ${input.state},result = ${stored}::text::json,ended_at = ${input.endedAt} WHERE run_id = ${input.runId}::uuid AND ordinal = ${input.ordinal} AND state IN ('running','uncertain')`;
  if (result.count !== 1) throw new CodeDataError("CONFLICT", "Call is missing or already finished.");
};
/** Retention is 30 days after termination; active/queued runs and immutable versions are never swept. */
export const expireCodeRuns = async (options: { now: Date; limit: number; db?: CodeDb }): Promise<number> => {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1000)
    throw new RangeError("Invalid Code retention batch size");
  const db = options.db ?? sql;
  const cutoff = new Date(options.now.getTime() - 30 * 86_400_000);
  const result =
    await db`DELETE FROM code.runs WHERE id IN (SELECT id FROM code.runs WHERE ended_at <= ${cutoff} ORDER BY ended_at,id LIMIT ${options.limit} FOR UPDATE SKIP LOCKED)`;
  return result.count;
};

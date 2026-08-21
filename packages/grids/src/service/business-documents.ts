import { createHash } from "node:crypto";
import { err, fail, ok, type Result, type ServiceError } from "@k2b/stdlib";
import { isUniqueViolation } from "@valentinkolb/cloud/services";
import { sql as defaultSql, type SQL, type SQLQuery } from "bun";
import { z } from "zod";
import {
  type BusinessDocument,
  type BusinessDocumentProfileSummary,
  type BusinessDocumentRelationship,
  BusinessDocumentRelationshipSchema,
  type BusinessDocumentSource,
  type BusinessDocumentSourceRevision,
  BusinessDocumentSourceRevisionSchema,
  BusinessDocumentSourceSchema,
} from "../business-document-contracts";
import {
  type BusinessDocumentArtifactDraft,
  type BusinessDocumentProfile,
  businessDocumentProfiles,
  profileKey,
  profileRegistry,
} from "../business-document-profiles";
import { logAudit } from "./audit";
import { parseJsonbRow } from "./jsonb";
import { insertWithShortIdForDb } from "./short-id";

const MAX_ARTIFACTS = 8;
const MAX_TOTAL_ARTIFACT_BYTES = 100 * 1024 * 1024;
export const MAX_BUSINESS_DOCUMENT_INPUT_BYTES = 5 * 1024 * 1024;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type BusinessDocumentRow = {
  id: string;
  short_id: string;
  base_id: string;
  base_short_id: string;
  profile_id: string;
  profile_version: number;
  request_hash: string;
  source: unknown;
  source_revision: unknown;
  snapshot: unknown;
  snapshot_sha256: string;
  document_number: string;
  relationship_kind: BusinessDocumentRelationship;
  predecessor_id: string | null;
  predecessor_short_id: string | null;
  renderer_version: string;
  validator_version: string;
  validation_status: "valid" | "warning";
  validation_report: unknown;
  issued_by: string | null;
  issued_at: Date;
};

type ArtifactRow = {
  document_id: string;
  artifact_key: string;
  filename: string;
  media_type: string;
  size_bytes: number | string;
  sha256: string;
};

type IssueInput = {
  baseId: string;
  profileId: string;
  profileVersion: number;
  idempotencyKey: string;
  source: BusinessDocumentSource;
  sourceRevision: BusinessDocumentSourceRevision;
  snapshot: Record<string, unknown>;
  relationship: BusinessDocumentRelationship;
  predecessorId?: string;
  actor: BusinessDocumentActor;
  issuedAt?: Date;
};

export type BusinessDocumentActor =
  | { kind: "user"; userId: string }
  | { kind: "service_account"; serviceAccountId: string; delegatedUserId: string | null; credentialId: string | null }
  | { kind: "system" };

const BusinessDocumentActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: z.uuid() }).strict(),
  z
    .object({
      kind: z.literal("service_account"),
      serviceAccountId: z.uuid(),
      delegatedUserId: z.uuid().nullable(),
      credentialId: z.uuid().nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("system") }).strict(),
]);

const actorUserId = (actor: BusinessDocumentActor): string | null =>
  actor.kind === "user" ? actor.userId : actor.kind === "service_account" ? actor.delegatedUserId : null;

const sha256Hex = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

const canonicalJsonValue = (value: unknown, path = "$", seen = new Set<object>()): JsonValue => {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && value.includes("\0")) throw err.badInput(`${path} must not contain NUL`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw err.badInput(`${path} must contain only finite numbers`);
    return value;
  }
  if (typeof value !== "object") throw err.badInput(`${path} must contain only JSON values`);
  if (seen.has(value)) throw err.badInput(`${path} must not contain circular values`);
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item, index) => canonicalJsonValue(item, `${path}[${index}]`, seen));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw err.badInput(`${path} must contain only plain JSON objects`);
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => {
          if (key.includes("\0")) throw err.badInput(`${path} contains a key with NUL`);
          return [key, canonicalJsonValue(item, `${path}.${key}`, seen)];
        }),
    );
  } finally {
    seen.delete(value);
  }
};

export const canonicalBusinessDocumentJson = (
  value: Record<string, unknown>,
): { value: Record<string, JsonValue>; json: string; sha256: string } => {
  const canonical = canonicalJsonValue(value);
  if (!canonical || Array.isArray(canonical) || typeof canonical !== "object")
    throw err.badInput("Business Document input must be an object");
  const json = JSON.stringify(canonical);
  if (new TextEncoder().encode(json).byteLength > MAX_BUSINESS_DOCUMENT_INPUT_BYTES) {
    throw err.badInput(`Business Document JSON exceeds the ${MAX_BUSINESS_DOCUMENT_INPUT_BYTES} byte limit`);
  }
  return { value: canonical, json, sha256: sha256Hex(json) };
};

const serviceError = (error: unknown): ServiceError | null => {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error &&
    "status" in error &&
    typeof error.code === "string" &&
    typeof error.message === "string" &&
    typeof error.status === "number"
  ) {
    return error as ServiceError;
  }
  return null;
};

const artifactMetadata = (row: ArtifactRow) => ({
  key: row.artifact_key,
  filename: row.filename,
  mediaType: row.media_type,
  sizeBytes: Number(row.size_bytes),
  sha256: row.sha256,
});

const mapDocument = (row: BusinessDocumentRow, artifacts: ArtifactRow[]): BusinessDocument => ({
  id: row.short_id,
  baseId: row.base_short_id,
  profileId: row.profile_id,
  profileVersion: row.profile_version,
  source: parseJsonbRow<BusinessDocumentSource>(row.source, { appId: "unknown", resourceType: "unknown", resourceId: "unknown" }),
  sourceRevision: parseJsonbRow<BusinessDocumentSourceRevision>(row.source_revision, {
    id: "unknown",
    observedAt: row.issued_at.toISOString(),
    evidence: {},
  }),
  snapshotSha256: row.snapshot_sha256,
  number: row.document_number,
  relationship: row.relationship_kind,
  predecessorId: row.predecessor_short_id,
  rendererVersion: row.renderer_version,
  validatorVersion: row.validator_version,
  validationStatus: row.validation_status,
  validationReport: parseJsonbRow<Record<string, unknown>>(row.validation_report, {}),
  issuedAt: row.issued_at.toISOString(),
  artifacts: artifacts.map(artifactMetadata),
});

const documentSelect = (db: SQL, where: SQLQuery): Promise<BusinessDocumentRow[]> => db<BusinessDocumentRow[]>`
  SELECT document.*, base.short_id AS base_short_id, predecessor.short_id AS predecessor_short_id
  FROM grids.business_documents document
  JOIN grids.bases base ON base.id = document.base_id
  LEFT JOIN grids.business_documents predecessor ON predecessor.id = document.predecessor_id
  WHERE ${where}
`;

const loadArtifacts = async (db: SQL, documentIds: readonly string[]): Promise<Map<string, ArtifactRow[]>> => {
  if (documentIds.length === 0) return new Map();
  const rows = await db<ArtifactRow[]>`
    SELECT document_id::text, artifact_key, filename, media_type, size_bytes, sha256
    FROM grids.business_document_artifacts
    WHERE document_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${documentIds}::jsonb))
    ORDER BY document_id, artifact_key
  `;
  const result = new Map<string, ArtifactRow[]>();
  for (const row of rows) result.set(row.document_id, [...(result.get(row.document_id) ?? []), row]);
  return result;
};

const hydrateRows = async (db: SQL, rows: BusinessDocumentRow[]): Promise<BusinessDocument[]> => {
  const artifacts = await loadArtifacts(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => mapDocument(row, artifacts.get(row.id) ?? []));
};

const validateArtifacts = (drafts: BusinessDocumentArtifactDraft[]): Result<Array<BusinessDocumentArtifactDraft & { sha256: string }>> => {
  if (drafts.length < 2 || drafts.length > MAX_ARTIFACTS) {
    return fail(err.badInput(`A Business Document profile must produce between 2 and ${MAX_ARTIFACTS} artifacts.`));
  }
  const keys = new Set<string>();
  let totalBytes = 0;
  for (const artifact of drafts) {
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(artifact.key) || keys.has(artifact.key)) {
      return fail(err.badInput("Business Document artifact keys must be unique lowercase identifiers."));
    }
    keys.add(artifact.key);
    if (
      !artifact.filename.trim() ||
      artifact.filename !== artifact.filename.trim() ||
      artifact.filename.length > 255 ||
      artifact.filename.includes("\0")
    ) {
      return fail(err.badInput(`Business Document artifact ${artifact.key} has an invalid filename.`));
    }
    if (!artifact.mediaType.trim() || artifact.mediaType.length > 255 || artifact.mediaType.includes("\0")) {
      return fail(err.badInput(`Business Document artifact ${artifact.key} has an invalid media type.`));
    }
    if (artifact.bytes.byteLength === 0) return fail(err.badInput(`Business Document artifact ${artifact.key} is empty.`));
    totalBytes += artifact.bytes.byteLength;
  }
  if (totalBytes > MAX_TOTAL_ARTIFACT_BYTES) {
    return fail(err.badInput(`Business Document artifacts exceed the ${MAX_TOTAL_ARTIFACT_BYTES} byte total limit.`));
  }
  const pdf = drafts.find((artifact) => artifact.key === "pdf");
  if (!pdf || pdf.mediaType !== "application/pdf" || new TextDecoder().decode(pdf.bytes.subarray(0, 4)) !== "%PDF") {
    return fail(err.badInput('A Business Document profile must produce a valid "pdf" artifact.'));
  }
  const structured = drafts.find((artifact) => artifact.key === "structured");
  if (!structured || !["application/json", "application/xml", "text/xml"].includes(structured.mediaType)) {
    return fail(err.badInput('A Business Document profile must produce a JSON or XML "structured" artifact.'));
  }
  return ok(drafts.map((artifact) => ({ ...artifact, sha256: sha256Hex(artifact.bytes) })));
};

const requestHashFor = (params: {
  profileId: string;
  profileVersion: number;
  source: BusinessDocumentSource;
  sourceRevision: BusinessDocumentSourceRevision;
  snapshotSha256: string;
  relationship: BusinessDocumentRelationship;
  predecessorId: string | null;
  issuedAt: string | null;
}) => sha256Hex(JSON.stringify(canonicalJsonValue(params)));

const cursorEncode = (row: Pick<BusinessDocumentRow, "issued_at" | "id">): string =>
  Buffer.from(JSON.stringify([row.issued_at.toISOString(), row.id])).toString("base64url");

const cursorDecode = (cursor: string | undefined): { issuedAt: Date; id: string } | null => {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") return null;
    const issuedAt = new Date(parsed[0]);
    if (!Number.isFinite(issuedAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(parsed[1])) return null;
    return { issuedAt, id: parsed[1] };
  } catch {
    return null;
  }
};

export const createBusinessDocumentService = (options: { profiles?: readonly BusinessDocumentProfile[]; db?: SQL } = {}) => {
  const db = options.db ?? defaultSql;
  const profiles = profileRegistry(options.profiles ?? businessDocumentProfiles);

  const summaries = (): BusinessDocumentProfileSummary[] =>
    [...profiles.values()]
      .map(({ id, version, title, description, rendererVersion, validatorVersion }) => ({
        id,
        version,
        title,
        description,
        rendererVersion,
        validatorVersion,
      }))
      .sort((left, right) => left.id.localeCompare(right.id) || left.version - right.version);

  const getInternalFrom = async (
    client: SQL,
    id: string,
  ): Promise<(BusinessDocument & { internalId: string; requestHash: string }) | null> => {
    const rows = await documentSelect(client, defaultSql`document.id = ${id}::uuid`);
    const row = rows[0];
    if (!row) return null;
    const [document] = await hydrateRows(client, [row]);
    return document ? { ...document, internalId: row.id, requestHash: row.request_hash } : null;
  };

  const getInternal = (id: string) => getInternalFrom(db, id);

  const getByShortId = async (shortId: string): Promise<(BusinessDocument & { internalId: string }) | null> => {
    const rows = await documentSelect(db, defaultSql`document.short_id = ${shortId}`);
    const row = rows[0];
    if (!row) return null;
    const [document] = await hydrateRows(db, [row]);
    return document ? { ...document, internalId: row.id } : null;
  };

  const loadReplay = async (baseId: string, operationKeyHash: string, requestHash: string): Promise<Result<BusinessDocument>> => {
    const rows = await documentSelect(
      db,
      defaultSql`document.base_id = ${baseId}::uuid AND document.operation_key_hash = ${operationKeyHash}`,
    );
    const row = rows[0];
    if (!row) return fail(err.internal("Business Document retry receipt disappeared."));
    if (row.request_hash !== requestHash)
      return fail(err.conflict("Idempotency key was already used for a different Business Document request."));
    const [document] = await hydrateRows(db, [row]);
    return document ? ok(document) : fail(err.internal("Business Document retry receipt could not be read."));
  };

  const issue = async (input: IssueInput): Promise<Result<{ document: BusinessDocument; replayed: boolean }>> => {
    if (!z.uuid().safeParse(input.baseId).success) return fail(err.badInput("Business Document Base ID is invalid."));
    if (
      input.idempotencyKey !== input.idempotencyKey.trim() ||
      input.idempotencyKey.length < 1 ||
      input.idempotencyKey.length > 200 ||
      input.idempotencyKey.includes("\0")
    ) {
      return fail(err.badInput("Business Document idempotency key is invalid."));
    }
    const parsedSource = BusinessDocumentSourceSchema.safeParse(input.source);
    if (!parsedSource.success) return fail(err.badInput("Business Document source is invalid."));
    const parsedRevision = BusinessDocumentSourceRevisionSchema.safeParse(input.sourceRevision);
    if (!parsedRevision.success) return fail(err.badInput("Business Document source revision is invalid."));
    const parsedRelationship = BusinessDocumentRelationshipSchema.safeParse(input.relationship);
    if (!parsedRelationship.success) return fail(err.badInput("Business Document relationship is invalid."));
    if (
      (parsedRelationship.data === "original" && input.predecessorId !== undefined) ||
      (parsedRelationship.data !== "original" && input.predecessorId === undefined)
    ) {
      return fail(err.badInput("Business Document relationship and predecessor do not match."));
    }
    if (input.predecessorId !== undefined && !z.uuid().safeParse(input.predecessorId).success) {
      return fail(err.badInput("Business Document predecessor ID is invalid."));
    }
    const parsedActor = BusinessDocumentActorSchema.safeParse(input.actor);
    if (!parsedActor.success) return fail(err.badInput("Business Document actor is invalid."));
    if (input.issuedAt !== undefined && (!(input.issuedAt instanceof Date) || !Number.isFinite(input.issuedAt.getTime()))) {
      return fail(err.badInput("Business Document issue time is invalid."));
    }
    const profile = profiles.get(profileKey(input.profileId, input.profileVersion));
    if (!profile) return fail(err.badInput(`Unknown Business Document profile ${input.profileId}@${input.profileVersion}.`));
    const parsed = profile.input.safeParse(input.snapshot);
    if (!parsed.success) {
      return fail(
        err.badInput(
          `Business Document input does not match ${profile.id}@${profile.version}: ${parsed.error.issues
            .slice(0, 10)
            .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
            .join("; ")}`,
        ),
      );
    }
    let snapshot: ReturnType<typeof canonicalBusinessDocumentJson>;
    let source: ReturnType<typeof canonicalBusinessDocumentJson>;
    let sourceRevision: ReturnType<typeof canonicalBusinessDocumentJson>;
    try {
      snapshot = canonicalBusinessDocumentJson(parsed.data);
      source = canonicalBusinessDocumentJson(parsedSource.data);
      sourceRevision = canonicalBusinessDocumentJson(parsedRevision.data);
    } catch (error) {
      const known = serviceError(error);
      return known ? fail(known) : Promise.reject(error);
    }
    const operationKeyHash = sha256Hex(input.idempotencyKey);
    const requestHash = requestHashFor({
      profileId: profile.id,
      profileVersion: profile.version,
      source: parsedSource.data,
      sourceRevision: parsedRevision.data,
      snapshotSha256: snapshot.sha256,
      relationship: parsedRelationship.data,
      predecessorId: input.predecessorId ?? null,
      issuedAt: input.issuedAt?.toISOString() ?? null,
    });
    const existing = await loadReplay(input.baseId, operationKeyHash, requestHash);
    if (existing.ok) return ok({ document: existing.data, replayed: true });
    if (existing.error.code !== "INTERNAL") return existing;

    const issuedAt = input.issuedAt ?? new Date();
    try {
      const created = await db.begin(async (tx) => {
        const replayRows = await documentSelect(
          tx,
          defaultSql`document.base_id = ${input.baseId}::uuid AND document.operation_key_hash = ${operationKeyHash}`,
        );
        if (replayRows[0]) {
          if (replayRows[0].request_hash !== requestHash)
            throw err.conflict("Idempotency key was already used for a different Business Document request.");
          const [document] = await hydrateRows(tx, [replayRows[0]]);
          if (!document) throw err.internal("Business Document retry receipt could not be read.");
          return { document, replayed: true };
        }
        const [base] = await tx<Array<{ id: string; short_id: string }>>`
          SELECT id::text, short_id FROM grids.bases WHERE id = ${input.baseId}::uuid AND deleted_at IS NULL FOR SHARE
        `;
        if (!base) throw err.notFound("Base");
        let predecessor: (BusinessDocument & { internalId: string; requestHash: string }) | null = null;
        if (input.relationship !== "original") {
          predecessor = input.predecessorId ? await getInternalFrom(tx, input.predecessorId) : null;
          if (!predecessor || predecessor.baseId !== base.short_id) {
            throw err.notFound("Business Document predecessor");
          }
          if (predecessor.profileId !== profile.id) throw err.badInput("Business Document predecessor must use the same profile.");
        }
        await tx`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`grids:business-document:${input.baseId}:${profile.id}:${profile.version}`}, 0)
          )
        `;
        await tx`
          INSERT INTO grids.business_document_counters (base_id, profile_id, profile_version)
          VALUES (${input.baseId}::uuid, ${profile.id}, ${profile.version})
          ON CONFLICT DO NOTHING
        `;
        const [counter] = await tx<Array<{ next_value: number | string | bigint }>>`
          SELECT next_value FROM grids.business_document_counters
          WHERE base_id = ${input.baseId}::uuid AND profile_id = ${profile.id} AND profile_version = ${profile.version}
          FOR UPDATE
        `;
        const value = Number(counter?.next_value);
        if (!Number.isSafeInteger(value) || value < 1) throw err.internal("Business Document number series is exhausted.");
        const number = profile.formatNumber({ value, issuedAt });
        if (!number.trim() || number !== number.trim() || number.length > 200 || number.includes("\0")) {
          throw err.internal(`Business Document profile ${profile.id}@${profile.version} produced an invalid number.`);
        }
        const rendered = await profile.issue(parsed.data, { number, issuedAt });
        const artifacts = validateArtifacts(rendered.artifacts);
        if (!artifacts.ok) throw artifacts.error;
        const validationReport = canonicalBusinessDocumentJson(rendered.validationReport);
        const documentId = Bun.randomUUIDv7();
        const row = await insertWithShortIdForDb(tx, "idx_grids_business_documents_short_id", async (attempt, shortId) => {
          const [inserted] = await attempt<BusinessDocumentRow[]>`
            INSERT INTO grids.business_documents (
              id, short_id, base_id, profile_id, profile_version, operation_key_hash, request_hash,
              source, source_revision, snapshot, snapshot_sha256, document_number, relationship_kind, predecessor_id,
              renderer_version, validator_version, validation_status, validation_report, issued_actor, issued_by, issued_at
            ) VALUES (
              ${documentId}::uuid, ${shortId}, ${input.baseId}::uuid, ${profile.id}, ${profile.version}, ${operationKeyHash}, ${requestHash},
              ${source.value}::jsonb, ${sourceRevision.value}::jsonb, ${snapshot.value}::jsonb, ${snapshot.sha256}, ${number},
              ${input.relationship}, ${predecessor?.internalId ?? null}::uuid, ${profile.rendererVersion}, ${profile.validatorVersion},
              ${rendered.validationStatus}, ${validationReport.value}::jsonb, ${parsedActor.data}::jsonb, ${actorUserId(parsedActor.data)}::uuid, ${issuedAt}
            )
            RETURNING *, ${base.short_id}::text AS base_short_id,
              ${predecessor?.id ?? null}::text AS predecessor_short_id
          `;
          if (!inserted) throw new Error("Business Document insert returned no row");
          return inserted;
        });
        for (const artifact of artifacts.data) {
          await tx`
            INSERT INTO grids.business_document_artifacts (
              document_id, artifact_key, filename, media_type, bytes, size_bytes, sha256
            ) VALUES (
              ${documentId}::uuid, ${artifact.key}, ${artifact.filename}, ${artifact.mediaType}, ${artifact.bytes},
              ${artifact.bytes.byteLength}, ${artifact.sha256}
            )
          `;
        }
        await tx`
          UPDATE grids.business_document_counters SET next_value = ${value + 1}
          WHERE base_id = ${input.baseId}::uuid AND profile_id = ${profile.id} AND profile_version = ${profile.version}
        `;
        await logAudit(
          {
            baseId: input.baseId,
            userId: actorUserId(parsedActor.data),
            action: "business_document.issued",
            diff: {
              businessDocumentId: { old: null, new: row.short_id },
              number: { old: null, new: number },
              profile: { old: null, new: `${profile.id}@${profile.version}` },
              snapshotSha256: { old: null, new: snapshot.sha256 },
              relationship: { old: null, new: input.relationship },
            },
          },
          tx,
        );
        const [document] = await hydrateRows(tx, [row]);
        if (!document) throw err.internal("Issued Business Document could not be read.");
        return { document, replayed: false };
      });
      return ok(created);
    } catch (error) {
      if (isUniqueViolation(error, "business_documents_base_id_operation_key_hash_key")) {
        const replay = await loadReplay(input.baseId, operationKeyHash, requestHash);
        return replay.ok ? ok({ document: replay.data, replayed: true }) : replay;
      }
      const known = serviceError(error);
      if (known) return fail(known);
      throw error;
    }
  };

  const list = async (params: { baseId: string; profileId?: string; limit: number; cursor?: string }) => {
    const cursor = cursorDecode(params.cursor);
    if (params.cursor && !cursor) return fail(err.badInput("Invalid Business Document cursor."));
    const rows = await documentSelect(
      db,
      defaultSql`
      document.base_id = ${params.baseId}::uuid
      AND (${params.profileId ?? null}::text IS NULL OR document.profile_id = ${params.profileId ?? null})
      AND (
        ${cursor?.issuedAt ?? null}::timestamptz IS NULL
        OR (document.issued_at, document.id) < (${cursor?.issuedAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid)
      )
      ORDER BY document.issued_at DESC, document.id DESC
      LIMIT ${params.limit + 1}
    `,
    );
    const hasMore = rows.length > params.limit;
    const page = rows.slice(0, params.limit);
    return ok({
      items: await hydrateRows(db, page),
      cursor: hasMore && page.length > 0 ? cursorEncode(page[page.length - 1]!) : null,
      hasMore,
    });
  };

  const artifact = async (documentId: string, key: string) => {
    const [row] = await db<Array<ArtifactRow & { bytes: Uint8Array }>>`
      SELECT document_id::text, artifact_key, filename, media_type, bytes, size_bytes, sha256
      FROM grids.business_document_artifacts
      WHERE document_id = ${documentId}::uuid AND artifact_key = ${key}
    `;
    if (!row) return fail(err.notFound("Business Document artifact"));
    if (Number(row.size_bytes) !== row.bytes.byteLength || sha256Hex(row.bytes) !== row.sha256) {
      return fail(err.internal("Stored Business Document artifact failed its integrity check."));
    }
    return ok({ ...artifactMetadata(row), bytes: row.bytes });
  };

  return { profiles: summaries, issue, getInternal, getByShortId, list, artifact };
};

export const businessDocumentService = createBusinessDocumentService();

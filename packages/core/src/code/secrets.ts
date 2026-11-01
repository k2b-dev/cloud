import { sql } from "@k2b/cloud";
import { codeHttpOriginAllowed } from "@k2b/cloud/api";
import type { CodeSecretVersionBinding } from "@k2b/cloud/contracts";
import { type PurposeSecretRoots, purposeSecretCipher } from "@k2b/cloud/services";
import { approvalArgsDigest } from "@k2b/cloud/services/approvals";
import type { SQL } from "bun";
import type { z } from "zod";
import { type CodeContext, CodeDataError, codePerson, requireCodePermission } from "./access";
import { readCodeOwnOrigins } from "./origins";
import { CodeSecretBindingSchema, type CodeSecretMetadata, codeSecretContracts } from "./secret-contracts";
import { codeSettings } from "./settings";
import { findCode, lockCodeForEdit } from "./store";

/** Stable purpose and row context for offline APP_SECRET rotation; never an independent encryption root. */
export const CODE_SECRET_PURPOSE = "cloud.code.secret.v1";
export const codeSecretContext = (codeId: string, name: string) => JSON.stringify([codeId, name]);
type MetadataRow = { name: string; binding_revision: string; binding: unknown; configured: boolean };
const metadata = (row: MetadataRow): CodeSecretMetadata => ({
  ...CodeSecretBindingSchema.parse(row.binding),
  name: row.name,
  binding_revision: row.binding_revision,
  configured: row.configured,
});
const badInput = (): never => {
  throw new CodeDataError("BAD_INPUT", "Invalid Code secret input.");
};
/** Write-only editor operation. A value replacement keeps its binding; changed destinations create new evidence. */
export async function setCodeSecret(raw: z.input<typeof codeSecretContracts.set.input>, context: CodeContext) {
  codePerson(context, true);
  if (context.authority.actor.delegation?.credentialKind === "mandate")
    throw new CodeDataError("FORBIDDEN", "Use private interactive input to set a Code secret.");
  const parsed = codeSecretContracts.set.input.safeParse(raw);
  if (!parsed.success) return badInput();
  const input = parsed.data;
  if (Buffer.byteLength(JSON.stringify(input)) > (await codeSettings.get("core.code.payload_bytes"))) return badInput();
  const ownOrigins = await readCodeOwnOrigins();
  if (input.binding && !codeHttpOriginAllowed(input.binding.origin, ownOrigins)) return badInput();
  return sql.begin(async (tx) => {
    await lockCodeForEdit(input.codeId, context, tx);
    const [current] = await tx<MetadataRow[]>`SELECT s.name,s.binding_revision,b.binding,s.encrypted IS NOT NULL AS configured
      FROM code.secrets s JOIN code.secret_bindings b USING(code_id,name,binding_revision)
      WHERE s.code_id=${input.codeId} AND s.name=${input.name}`;
    if ((current?.binding_revision ?? null) !== input.binding_revision)
      throw new CodeDataError("CONFLICT", "Code secret binding changed. Read its current metadata and try again.");
    const binding = input.binding ?? (current ? metadata(current) : null);
    if (!binding) return badInput();
    // Parse only binding fields; metadata contains name/revision/configured, which are not binding content.
    const destination = { origin: binding.origin, pathPrefix: binding.pathPrefix, headers: binding.headers };
    let revision = current?.binding_revision;
    if (!current || approvalArgsDigest(destination) !== approvalArgsDigest(current.binding)) {
      const [row] = await tx<{ binding_revision: string }[]>`INSERT INTO code.secret_bindings(code_id,name,binding)
        VALUES(${input.codeId},${input.name},${JSON.stringify(destination)}::jsonb) RETURNING binding_revision`;
      revision = row!.binding_revision;
    }
    if (!revision) return badInput();
    let encrypted: string;
    try {
      encrypted = purposeSecretCipher(CODE_SECRET_PURPOSE).encrypt(input.value, codeSecretContext(input.codeId, input.name));
    } catch {
      return badInput();
    }
    await tx`INSERT INTO code.secrets(code_id,name,binding_revision,encrypted) VALUES(${input.codeId},${input.name},${revision}::uuid,${encrypted})
      ON CONFLICT(code_id,name) DO UPDATE SET binding_revision=excluded.binding_revision,encrypted=excluded.encrypted`;
    return { secret: { ...destination, name: input.name, binding_revision: revision, configured: true } };
  });
}
/** Editors only, including for metadata. Values and ciphertext never leave this service. */
export async function listCodeSecrets(raw: z.input<typeof codeSecretContracts.list.input>, context: CodeContext) {
  const input = codeSecretContracts.list.input.parse(raw);
  codePerson(context);
  return sql.begin(async (tx) => {
    await tx`SELECT id FROM code.codes WHERE id=${input.codeId} FOR SHARE`;
    const code = await findCode(input.codeId, tx);
    if (!code) throw new CodeDataError("NOT_FOUND", "Code not found.");
    if ((await requireCodePermission(code, context, false, tx)) !== "editor")
      throw new CodeDataError("FORBIDDEN", "Code editor access required.");
    const rows = await tx<MetadataRow[]>`SELECT s.name,s.binding_revision,b.binding,s.encrypted IS NOT NULL AS configured
      FROM code.secrets s JOIN code.secret_bindings b USING(code_id,name,binding_revision)
      WHERE s.code_id=${input.codeId} AND (${input.cursor ?? null}::text IS NULL OR s.name>${input.cursor ?? null}) ORDER BY s.name LIMIT ${input.limit + 1}`;
    const items: CodeSecretMetadata[] = [];
    let used = 0;
    const byteLimit = await codeSettings.get("core.code.payload_bytes");
    for (const row of rows.slice(0, input.limit)) {
      const item = metadata(row);
      const size = Buffer.byteLength(JSON.stringify(item));
      if (used + size > byteLimit && items.length) break;
      items.push(item);
      used += size;
    }
    return { items, nextCursor: rows.length > items.length ? items.at(-1)!.name : null };
  });
}
/** Permission-aware metadata-only snapshot for the platform's exact delete approval. */
export async function reviewCodeSecretDeletion(raw: z.input<typeof codeSecretContracts.delete.input>, context: CodeContext) {
  const input = codeSecretContracts.delete.input.parse(raw);
  codePerson(context, true);
  return sql.begin(async (tx) => {
    await lockCodeForEdit(input.codeId, context, tx);
    const [row] = await tx<MetadataRow[]>`SELECT s.name,s.binding_revision,b.binding,s.encrypted IS NOT NULL AS configured
      FROM code.secrets s JOIN code.secret_bindings b USING(code_id,name,binding_revision)
      WHERE s.code_id=${input.codeId} AND s.name=${input.name} AND s.binding_revision=${input.binding_revision}::uuid`;
    if (!row) throw new CodeDataError("CONFLICT", "Code secret binding changed or is unavailable.");
    return metadata(row);
  });
}
/** Clear the value immediately for every version, retaining immutable binding evidence. */
export async function deleteCodeSecret(raw: z.input<typeof codeSecretContracts.delete.input>, context: CodeContext) {
  const input = codeSecretContracts.delete.input.parse(raw);
  codePerson(context, true);
  return sql.begin(async (tx) => {
    await lockCodeForEdit(input.codeId, context, tx);
    const rows = await tx`UPDATE code.secrets SET encrypted=NULL WHERE code_id=${input.codeId} AND name=${input.name}
      AND binding_revision=${input.binding_revision}::uuid RETURNING name`;
    if (!rows.length) throw new CodeDataError("CONFLICT", "Code secret binding changed or is unavailable.");
    return { deleted: true };
  });
}
/** Submission pins historical evidence, never whatever binding is current when an old version runs. Caller holds the Code lock. */
export async function validateCodeSecretBindings(codeId: string, bindings: readonly CodeSecretVersionBinding[], db: SQL) {
  for (const binding of bindings) {
    const [row] = await db<{ binding: unknown }[]>`SELECT binding FROM code.secret_bindings
      WHERE code_id=${codeId} AND name=${binding.name} AND binding_revision=${binding.binding_revision}::uuid`;
    const { name: _name, binding_revision: _revision, ...destination } = binding;
    if (!row || approvalArgsDigest(row.binding) !== approvalArgsDigest(destination)) return badInput();
  }
}
/** Operator-only bounded re-encryption while current+previous APP_SECRET roots are available. No values returned.
 * Repeat until nextCursor=null, then retire previous. Each row is locked; editor replacements cannot be overwritten.
 */
export async function reencryptCodeSecretBatch(
  input: { cursor?: { codeId: string; name: string }; limit: number },
  db: SQL = sql,
  roots?: PurposeSecretRoots,
) {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) return badInput();
  return db.begin(async (tx) => {
    const rows = await tx<{ code_id: string; name: string; encrypted: string }[]>`SELECT code_id,name,encrypted FROM code.secrets
      WHERE encrypted IS NOT NULL AND (${input.cursor?.codeId ?? null}::text IS NULL OR (code_id,name)>(${input.cursor?.codeId ?? null},${input.cursor?.name ?? null}))
      ORDER BY code_id,name LIMIT ${input.limit} FOR UPDATE`;
    const cipher = purposeSecretCipher(CODE_SECRET_PURPOSE, roots);
    for (const row of rows) {
      const context = codeSecretContext(row.code_id, row.name);
      let encrypted: string;
      try {
        encrypted = cipher.encrypt(cipher.decrypt(row.encrypted, context), context);
      } catch {
        throw new CodeDataError("CONFLICT", "Code secret is unreadable; retain both encryption roots and restore access before retrying.");
      }
      await tx`UPDATE code.secrets SET encrypted=${encrypted} WHERE code_id=${row.code_id} AND name=${row.name}`;
    }
    const last = rows.at(-1);
    return { count: rows.length, nextCursor: rows.length === input.limit && last ? { codeId: last.code_id, name: last.name } : null };
  });
}

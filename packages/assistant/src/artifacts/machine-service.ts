import { getAccess, resolveDisplayNames } from "@k2b/cloud/server";
import { requestPublicHttps, secrets } from "@k2b/cloud/services";
import { type SQL, sql } from "bun";
import { z } from "zod";
import { LIMITS } from "./contracts";
import { HeaderValue, HTTP_BYTES, HTTP_TIMEOUT_MS, HttpRequest, SecretSave, SecretView } from "./http-contracts";
import { redactSecrets } from "./http-redaction";
import { machineIdentity, machineRights } from "./machine-authority";
import { MachineRights } from "./machine-contracts";
import { ArtifactError, type ArtifactIdentity, requireArtifact } from "./service";

export async function requireMachineExecution(db: SQL, id: string, identity: ArtifactIdentity, version?: number) {
  await machineIdentity(identity, id, "write");
  const resource = await requireArtifact(db, id, identity, "read");
  const rights = await machineRights(db, resource.row.id, id, identity);
  if (!rights.execute) throw new ArtifactError("ACCESS_DENIED");
  if (version !== undefined && resource.row.published_version !== version) throw new ArtifactError("CONFLICT");
  return { ...resource, rights };
}

export const machineAccess = {
  async list(id: string, identity: ArtifactIdentity) {
    return sql.begin(async (db) => {
      const { row } = await requireArtifact(db, id, identity, "admin");
      const policies = await db<{ access_id: string; rights: unknown; revision: string | null; status: string }[]>`
        SELECT l.access_id,m.rights,m.revision,s.status FROM assistant.artifact_access l
        JOIN auth.access a ON a.id=l.access_id JOIN auth.service_accounts s ON s.id=a.service_account_id
        LEFT JOIN assistant.artifact_machine_rights m ON m.access_id=a.id WHERE l.artifact_id=${row.id}::uuid`;
      const grants = await Promise.all(policies.map((policy) => getAccess({ id: policy.access_id }, db)));
      const entries = await resolveDisplayNames(grants.filter((entry) => entry !== null));
      return policies.flatMap((policy) => {
        const entry = entries.find((entry) => entry.id === policy.access_id);
        if (!entry) return [];
        return [
          {
            entry,
            rights: MachineRights.parse(
              policy.rights ? (typeof policy.rights === "string" ? JSON.parse(policy.rights) : policy.rights) : {},
            ),
            revision: policy.revision ?? null,
            status: policy.status,
          },
        ];
      });
    });
  },
  async save(id: string, accessId: string, input: { rights: MachineRights; expectedRevision: string | null }, identity: ArtifactIdentity) {
    const rights = MachineRights.parse(input.rights);
    return sql.begin(async (db) => {
      const { row } = await requireArtifact(db, id, identity, "admin");
      if (identity.actor.kind === "service_account" && identity.actor.delegatedUser === null) {
        const own = await machineRights(db, row.id, id, identity);
        if (!own.sharing) throw new ArtifactError("ACCESS_DENIED");
      }
      const [grant] = await db`SELECT a.id FROM auth.access a JOIN assistant.artifact_access l ON l.access_id=a.id
        JOIN auth.service_accounts s ON s.id=a.service_account_id WHERE l.artifact_id=${row.id}::uuid
        AND a.id=${z.uuid().parse(accessId)}::uuid AND s.status='active' AND s.kind IN ('agent','standalone','resource_bound')`;
      if (!grant) throw new ArtifactError("ACCESS_DENIED");
      const [current] = await db<
        { revision: string }[]
      >`SELECT revision FROM assistant.artifact_machine_rights WHERE access_id=${accessId}::uuid`;
      if ((current?.revision ?? null) !== input.expectedRevision) throw new ArtifactError("CONFLICT");
      const revision = crypto.randomUUID();
      await db`INSERT INTO assistant.artifact_machine_rights(access_id,rights,revision)
        VALUES(${accessId}::uuid,${JSON.stringify(rights)}::jsonb,${revision}::uuid)
        ON CONFLICT(access_id) DO UPDATE SET rights=EXCLUDED.rights,revision=EXCLUDED.revision`;
      return { rights, revision };
    });
  },
  async secretList(id: string, identity: ArtifactIdentity) {
    return sql.begin(async (db) => {
      const { row } = await requireArtifact(db, id, identity, "admin");
      const rows = await db<
        { name: string; origin: string; header: string; prefix: string; revision: string }[]
      >`SELECT name,origin,header,prefix,revision FROM assistant.artifact_machine_secrets WHERE artifact_id=${row.id}::uuid ORDER BY name`;
      return rows.map((row) => SecretView.parse({ ...row, configured: true }));
    });
  },
  async saveSecret(id: string, input: z.infer<typeof SecretSave>, identity: ArtifactIdentity) {
    const value = SecretSave.parse(input);
    // Encrypt before the transaction, then authorize again before committing.
    const encrypted = await secrets.encrypt(value.value);
    return sql.begin(async (db) => {
      const { row } = await requireArtifact(db, id, identity, "admin");
      if (identity.actor.kind === "service_account" && identity.actor.delegatedUser === null) {
        const rights = await machineRights(db, row.id, id, identity);
        if (!rights.sharing || !rights.secrets.includes(value.name)) throw new ArtifactError("ACCESS_DENIED");
      }
      const existing = await db<
        { name: string; revision: string }[]
      >`SELECT name,revision FROM assistant.artifact_machine_secrets WHERE artifact_id=${row.id}::uuid`;
      const current = existing.find((secret) => secret.name === value.name);
      if ((current?.revision ?? null) !== value.expectedRevision) throw new ArtifactError("CONFLICT");
      if (!current && existing.length >= LIMITS.files) throw new ArtifactError("STORAGE_FULL");
      const revision = crypto.randomUUID();
      await db`INSERT INTO assistant.artifact_machine_secrets(artifact_id,name,origin,header,prefix,encrypted,revision)
        VALUES(${row.id}::uuid,${value.name},${value.origin},${value.header},${value.prefix},${encrypted},${revision}::uuid)
        ON CONFLICT(artifact_id,name) DO UPDATE SET origin=EXCLUDED.origin,header=EXCLUDED.header,prefix=EXCLUDED.prefix,encrypted=EXCLUDED.encrypted,revision=EXCLUDED.revision`;
      return SecretView.parse({ ...value, revision, configured: true });
    });
  },
  async removeSecret(id: string, name: string, revision: string, identity: ArtifactIdentity) {
    return sql.begin(async (db) => {
      const { row } = await requireArtifact(db, id, identity, "admin");
      if (identity.actor.kind === "service_account" && identity.actor.delegatedUser === null) {
        const rights = await machineRights(db, row.id, id, identity);
        if (!rights.sharing || !rights.secrets.includes(name)) throw new ArtifactError("ACCESS_DENIED");
      }
      const removed =
        await db`DELETE FROM assistant.artifact_machine_secrets WHERE artifact_id=${row.id}::uuid AND name=${name} AND revision=${z.uuid().parse(revision)}::uuid RETURNING name`;
      if (!removed.length) throw new ArtifactError("CONFLICT");
      return { deleted: true };
    });
  },
};

/** One admitted HTTP effect. Its explicit origin/method grant is its approval. No personal approvals are consulted. */
export async function machineHttp(
  id: string,
  version: number,
  input: unknown,
  identity: ArtifactIdentity,
  signal: AbortSignal,
  send = requestPublicHttps,
) {
  const request = HttpRequest.parse(input);
  if (Buffer.from(request.body ?? "", "base64").byteLength > HTTP_BYTES) throw new ArtifactError("INVALID_INPUT");
  const inserted: { value: string; sent: string }[] = [];
  const headers: Record<string, string> = {};
  return sql.begin(async (db) => {
    const { row, rights } = await requireMachineExecution(db, id, identity, version);
    if (!rights.http.some((grant) => grant.origin === new URL(request.url).origin && grant.methods.includes(request.method)))
      throw new ArtifactError("ACCESS_DENIED");
    for (const [header, value] of Object.entries(request.headers)) {
      if (typeof value === "string") {
        headers[header] = value;
        continue;
      }
      if (!rights.secrets.includes(value.secret)) throw new ArtifactError("ACCESS_DENIED");
      const [secret] = await db<{ encrypted: string; origin: string; header: string; prefix: string }[]>`
        SELECT encrypted,origin,header,prefix FROM assistant.artifact_machine_secrets WHERE artifact_id=${row.id}::uuid AND name=${value.secret}`;
      if (!secret || secret.origin !== new URL(request.url).origin || secret.header !== header || secret.prefix !== value.prefix)
        throw new ArtifactError("ACCESS_DENIED");
      const plain = HeaderValue.parse(await secrets.decrypt(secret.encrypted));
      headers[header] = value.prefix + plain;
      inserted.push({ value: plain, sent: headers[header] });
    }
    if (Buffer.byteLength(JSON.stringify(headers)) > LIMITS.text) throw new ArtifactError("INVALID_INPUT");
    // Decryption and queueing never carry authority across revocation.
    await requireMachineExecution(db, id, identity, version);
    signal.throwIfAborted();
    const response = await send({
      url: request.url,
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : Buffer.from(request.body, "base64"),
      maxBytes: HTTP_BYTES,
      signal: AbortSignal.any([signal, AbortSignal.timeout(HTTP_TIMEOUT_MS)]),
    });
    const redacted = redactSecrets(response, inserted);
    return { status: response.status, headers: redacted.headers, body: Buffer.from(redacted.body).toString("base64") };
  });
}

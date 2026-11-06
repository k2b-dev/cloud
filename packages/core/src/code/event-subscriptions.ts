import { CodeCheckedVersionManifestSchema } from "@k2b/cloud/contracts";
import { cancelResourceEventSubscriptions, subscribeResourceEvent } from "@k2b/cloud/services/app-events";
import { type Mandate, mandates } from "@k2b/cloud/services/mandates";
import type { SQL } from "bun";
import { CodeDataError } from "./access";
import type { Code } from "./contracts";

export const CODE_EVENT_CONSUMER = "core.code";
/** Called with the Code row locked, in the activation/resume transaction. Old claims are fenced before new admission. */
export async function syncCodeEventSubscriptions(code: Code, versionId: string, db: SQL, mandate?: Mandate): Promise<void> {
  await cancelResourceEventSubscriptions(db, CODE_EVENT_CONSUMER, code.id);
  if (code.owner.kind !== "resource") return;
  const [version] = await db<
    { manifest: unknown }[]
  >`SELECT manifest FROM code.versions WHERE id=${versionId}::uuid AND code_id=${code.id}`;
  const manifest = CodeCheckedVersionManifestSchema.parse(version?.manifest);
  const entries = manifest.entrypoints.filter((entry) => entry.kind === "event").sort((a, b) => a.entrypoint.localeCompare(b.entrypoint));
  if (!entries.length) return;
  if (!mandate) {
    const [row] = await db<{ id: string }[]>`SELECT id FROM auth.mandates WHERE owner_app_id='runner' AND workload_type='code.version'
      AND workload_id=${versionId} AND state='active' AND confirmed_at IS NOT NULL ORDER BY id LIMIT 1 FOR SHARE`;
    mandate = row ? ((await mandates.get(row.id, { db })) ?? undefined) : undefined;
  }
  if (
    !mandate ||
    mandate.ownerAppId !== "runner" ||
    mandate.workloadType !== "code.version" ||
    mandate.workloadId !== versionId ||
    !mandate.confirmedAt ||
    (mandate.expiresAt && Date.parse(mandate.expiresAt) <= Date.now()) ||
    mandate.state !== "active" ||
    mandate.subject.type !== "service_account" ||
    mandate.subject.id !== code.serviceAccountId
  )
    throw new CodeDataError("CONFLICT", "The event execution mandate is unavailable.");
  // A fresh revision prevents resuming from reviving a cancelled delivery or including events from a pause.
  const revision = crypto.randomUUID();
  for (const entry of entries) {
    if (!entry.event || entry.event.place.type !== code.owner.ref.type || entry.event.place.id !== code.owner.ref.id)
      throw new CodeDataError("BAD_INPUT", "Event registration does not match the Code owner.");
    await subscribeResourceEvent(db, {
      appId: "core",
      type: entry.event.type,
      version: entry.event.version,
      binding: {
        consumer: CODE_EVENT_CONSUMER,
        key: code.id,
        revision,
        mandateId: mandate.id,
        mandateOwnerAppId: mandate.ownerAppId,
        mandateRevision: mandate.revision,
        place: code.owner.ref,
      },
    });
  }
}

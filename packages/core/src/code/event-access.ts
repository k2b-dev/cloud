import { sql } from "@k2b/cloud";
import { readResourcePrincipals } from "@k2b/cloud/capabilities/server";
import {
  type CloudResourceRef,
  type CodeCheckedVersionManifest,
  CodeCheckedVersionManifestSchema,
  type ResourcePrincipal,
} from "@k2b/cloud/contracts";
import { type AppEventEnvelope, AppEventEnvelopeSchema } from "@k2b/cloud/contracts/app-events";
import { AppAccessDeniedError } from "@k2b/cloud/server/middleware/app-access";
import { requireRegisteredAppAccess, resolveIssuanceAuthority } from "@k2b/cloud/services/identity/issue-invocation";
import { CodeDataError } from "./access";
import type { Code } from "./contracts";
import { codeSettings } from "./settings";

/** Personal Code executes as its owner; resource/app Code executes as its dedicated account. */
export function codeEventPrincipal(code: Pick<Code, "owner" | "serviceAccountId">): ResourcePrincipal {
  if (code.owner.kind === "person") return { type: "user", userId: code.owner.userId };
  if (!code.serviceAccountId) throw new CodeDataError("CONFLICT", "The Code account is unavailable.");
  return { type: "service_account", serviceAccountId: code.serviceAccountId };
}

/** Reuse the app's ordinary readable contract. No event or resource content leaves the provider. */
export async function canReadCodeEventPlace(
  code: Pick<Code, "owner" | "serviceAccountId">,
  place: CloudResourceRef,
  signal?: AbortSignal,
): Promise<boolean> {
  const principal = codeEventPrincipal(code);
  if (principal.type === "user") {
    // This reloads account authority for a read-only decision; no session or token is retained or issued.
    const authority = await resolveIssuanceAuthority(
      {
        sub: principal.userId,
        principal_type: "user",
        access_subject_type: "user",
        access_subject_id: principal.userId,
        credential_kind: "session",
        scopes: [],
      },
      "core",
    );
    try {
      await requireRegisteredAppAccess(authority, place.type.split(".")[0]!, { signal });
    } catch (error) {
      if (error instanceof AppAccessDeniedError) return false;
      throw error;
    }
  }
  const result = await readResourcePrincipals({ ref: place, principals: [principal], signal });
  if (result.state === "not_configured" && result.reason === "no_readable")
    throw new CodeDataError("BAD_INPUT", "This event place has no supported read-access check.");
  if (result.state !== "checked")
    throw new CodeDataError("CONFLICT", "The event place's read access cannot be checked. Try again when its app is available.");
  return result.readable.some((value) =>
    principal.type === "user"
      ? value.type === "user" && value.userId === principal.userId
      : value.type === "service_account" && value.serviceAccountId === principal.serviceAccountId,
  );
}

/** Resolve by the full declared pair; one event type may be registered at several places. */
export const codeEventEntry = (manifest: Pick<CodeCheckedVersionManifest, "entrypoints">, event: AppEventEnvelope) =>
  manifest.entrypoints.find(
    (entry) =>
      entry.kind === "event" &&
      entry.event?.type === event.type &&
      entry.event.version === event.version &&
      entry.event.place.type === event.place?.type &&
      entry.event.place.id === event.place.id,
  );

/** Activation checks run before the switch transaction, never while holding Code/policy locks. */
export async function requireCodeEventAccess(code: Code, versionId: string, signal?: AbortSignal): Promise<void> {
  const [version] = await sql<
    { manifest: unknown }[]
  >`SELECT manifest FROM code.versions WHERE code_id=${code.id} AND id=${versionId}::uuid`;
  const manifest = CodeCheckedVersionManifestSchema.parse(version?.manifest);
  const entries = manifest.entrypoints.filter((entry) => entry.kind === "event");
  // The existing per-Code event admission budget also bounds active registrations and activation reads.
  if (entries.length > (await codeSettings.get("core.code.event_backlog")))
    throw new CodeDataError("BAD_INPUT", "Event registrations exceed this Code's event backlog budget.");
  const budget = AbortSignal.timeout(await codeSettings.get("core.code.wall_clock_ms"));
  signal = signal ? AbortSignal.any([signal, budget]) : budget;
  const checked = new Set<string>();
  for (const entry of entries) {
    const place = entry.event!.place;
    const key = JSON.stringify([place.type, place.id]);
    if (checked.has(key)) continue;
    checked.add(key);
    if (!(await canReadCodeEventPlace(code, place, signal)))
      throw new CodeDataError(
        "FORBIDDEN",
        `The Code account cannot read the event place ${place.type}:${place.id}. Share the place with it before activating.`,
      );
  }
}

/** Run this for every attempt, including catch-up and explicit reruns, before issuing a Runner token. */
export async function checkCodeEventBeforeRun(
  code: Code,
  run: { version_id: string; entrypoint: string; input: unknown },
  signal?: AbortSignal,
): Promise<"resource_access_revoked" | "code_event_undeclared" | null> {
  const event = AppEventEnvelopeSchema.safeParse(run.input);
  if (!event.success) return "code_event_undeclared";
  const [version] = await sql<
    { manifest: unknown }[]
  >`SELECT manifest FROM code.versions WHERE code_id=${code.id} AND id=${run.version_id}::uuid`;
  const manifest = CodeCheckedVersionManifestSchema.parse(version?.manifest);
  const entry = codeEventEntry(manifest, event.data);
  if (!entry || entry.entrypoint !== run.entrypoint) return "code_event_undeclared";
  try {
    return (await canReadCodeEventPlace(code, entry.event!.place, signal)) ? null : "resource_access_revoked";
  } catch (error) {
    if (error instanceof CodeDataError && error.code === "BAD_INPUT") return "code_event_undeclared";
    throw error;
  }
}

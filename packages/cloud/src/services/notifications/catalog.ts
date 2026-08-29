import { sql } from "bun";
import type { AnyBoundNotificationDefinition } from "../../contracts/notification-types";
import { logger } from "../logging";
import { toPgTextArray } from "../postgres";

type NotificationCatalog = Readonly<Record<string, AnyBoundNotificationDefinition>>;

const RETRY_MS = 5_000;
const log = logger("notifications:catalog");

const isSchemaUnavailable = (error: unknown): boolean => {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "42P01" || error.code === "42703" || error.code === "3F000";
};

const upsertDefinition = async (definition: AnyBoundNotificationDefinition, db: typeof sql = sql): Promise<void> => {
  const recommended = toPgTextArray([...(definition.delivery?.recommended ?? [])]);
  const required = toPgTextArray([...(definition.delivery?.required ?? [])]);
  await db`
    INSERT INTO notifications.definitions (
      id, app_id, kind, label, description, presentation, recipient_kind,
      recommended_channels, required_channels, active, last_seen_at, updated_at
    ) VALUES (
      ${definition.id}, ${definition.appId}, ${definition.key}, ${definition.label},
      ${definition.description}, (${definition.presentation ? JSON.stringify(definition.presentation) : null}::text)::jsonb,
      ${definition.recipient}, ${recommended}::text[],
      ${required}::text[], true, now(), now()
    )
    ON CONFLICT (id) DO UPDATE SET
      app_id = EXCLUDED.app_id,
      kind = EXCLUDED.kind,
      label = EXCLUDED.label,
      description = EXCLUDED.description,
      presentation = EXCLUDED.presentation,
      recipient_kind = EXCLUDED.recipient_kind,
      recommended_channels = EXCLUDED.recommended_channels,
      required_channels = EXCLUDED.required_channels,
      active = true,
      last_seen_at = now(),
      updated_at = now()
  `;
};

/** Persist serializable app metadata; schemas and renderers remain code-owned. */
export const registerNotificationDefinitions = async (appId: string, definitions: NotificationCatalog): Promise<void> => {
  const current = Object.values(definitions);
  if (current.some((definition) => definition.appId !== appId)) {
    throw new Error(`Notification catalog for app "${appId}" contains a definition owned by another app`);
  }
  const ids = toPgTextArray(current.map((definition) => definition.id));
  await sql.begin(async (tx) => {
    for (const definition of current) await upsertDefinition(definition, tx);
    await tx`
      UPDATE notifications.definitions
      SET active = false, updated_at = now()
      WHERE app_id = ${appId} AND NOT (id = ANY(${ids}::text[]))
    `;
  });
};

/** Keep app startup rollout-safe when Core has not expanded the schema yet. */
export const startNotificationDefinitionRegistration = async (
  appId: string,
  definitions: NotificationCatalog,
  options: {
    register?: (appId: string, definitions: NotificationCatalog) => Promise<void>;
    retryMs?: number;
  } = {},
): Promise<() => void> => {
  const register = options.register ?? registerNotificationDefinitions;
  const retryMs = options.retryMs ?? RETRY_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void attempt();
    }, retryMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  };

  const attempt = async (): Promise<void> => {
    if (stopped) return;
    try {
      await register(appId, definitions);
      log.info("Notification definitions registered after schema became available", { appId });
    } catch (error) {
      log.warn("Notification definition registration failed; retrying", {
        appId,
        error: error instanceof Error ? error.message : "Notification catalog registration failed",
      });
      schedule();
    }
  };

  try {
    await register(appId, definitions);
  } catch (error) {
    if (!isSchemaUnavailable(error)) throw error;
    log.warn("Notification schema is not available yet; registration will retry", { appId });
    schedule();
  }

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
};

export const ensureNotificationDefinition = upsertDefinition;

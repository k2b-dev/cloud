import { type SQL, sql } from "bun";
import { ensureSchema } from "../services/postgres";
import builtInAppIds from "./built-in-app-ids.json";

export const resolveApplicationPackage = (appId: string, declared?: string): string => {
  const packageName = declared ?? appId;
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(appId) || typeof packageName !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(packageName)) {
    throw new TypeError("Application IDs and packages must be lowercase names of 1–80 characters.");
  }
  if (appId === "storage" || packageName === "storage")
    throw new Error("Application ID and package storage are reserved for public storage routing.");
  if (packageName !== appId && builtInAppIds.includes(packageName)) {
    throw new Error(`Package "${packageName}" is reserved for its built-in application.`);
  }
  return packageName;
};

/** Durable reservations survive app registry expiry. Serialize checks and writes across replicas. */
export const registerApplicationPackage = async (appId: string, declared?: string, db: SQL = sql): Promise<void> => {
  const packageName = resolveApplicationPackage(appId, declared);
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('cloud.application-packages'))`;
    await ensureSchema(tx, "platform");
    await tx`CREATE TABLE IF NOT EXISTS platform.application_packages (
      app_id TEXT PRIMARY KEY, package_name TEXT NOT NULL
    )`.simple();
    const conflicts = await tx<{ app_id: string; package_name: string }[]>`
      SELECT app_id, package_name FROM platform.application_packages
      WHERE (app_id <> ${appId} AND (app_id = ${packageName} OR package_name = ${appId}))
         OR (app_id = ${appId} AND package_name <> ${packageName})
      LIMIT 1
    `;
    if (conflicts.length) {
      throw new Error(
        `Application "${appId}" cannot claim package "${packageName}": an application ID or existing package assignment is reserved.`,
      );
    }
    await tx`INSERT INTO platform.application_packages (app_id, package_name) VALUES (${appId}, ${packageName}) ON CONFLICT DO NOTHING`;
  });
};

import { buildMetadata } from "./build-metadata";

export const APP_READINESS_PATH = "/_cloud/ready";

export const appReadinessResponse = (appId: string): Response =>
  Response.json({ status: "ready", appId, version: buildMetadata.version, release: buildMetadata.release });

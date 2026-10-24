import { hc } from "hono/client";
import { z } from "zod";
import type { AppAccessApi } from "../api/app-access";
import { AppAccessSnapshotSchema } from "../contracts/app-access";
import { AccessEntrySchema } from "../contracts/shared";
import type { AppAccessChange, AppAccessSnapshot } from "../services/app-access-management";

export class AppAccessClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Same audited route for an app's own settings and explicit administration repair. */
export const appAccessAdapter = (appId: string, options: { repair?: boolean } = {}) => {
  const client = hc<AppAccessApi>("/_cloud/app-access");
  const param = { appId };
  const query = options.repair ? { repair: "1" as const } : {};
  return {
    async read(signal?: AbortSignal): Promise<AppAccessSnapshot> {
      const response = await client[":appId"].$get({ param, query }, { init: { credentials: "same-origin", signal } });
      const data = await response.json();
      if (response.ok) return AppAccessSnapshotSchema.parse(data);
      throw new AppAccessClientError(
        typeof data === "object" && data !== null && "code" in data && typeof data.code === "string" ? data.code : "APP_ACCESS_READ_FAILED",
        typeof data === "object" && data !== null && "message" in data && typeof data.message === "string"
          ? data.message
          : "The access list could not be loaded.",
        response.status,
      );
    },
    async change(change: AppAccessChange, signal?: AbortSignal) {
      const response = await client[":appId"].$post({ param, query, json: change }, { init: { credentials: "same-origin", signal } });
      const data = await response.json();
      if (response.ok) return z.object({ entry: AccessEntrySchema.optional(), canUse: z.boolean() }).parse(data);
      throw new AppAccessClientError(
        typeof data === "object" && data !== null && "code" in data && typeof data.code === "string"
          ? data.code
          : "APP_ACCESS_CHANGE_FAILED",
        typeof data === "object" && data !== null && "message" in data && typeof data.message === "string"
          ? data.message
          : "The access change could not be confirmed.",
        response.status,
      );
    },
  };
};

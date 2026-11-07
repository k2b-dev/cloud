import { compileCapabilities } from "../../packages/cloud/src/_internal/capabilities";
import {
  AppStatusDetailDataSchema,
  AppStatusDetailInputSchema,
  AppStatusForgetDataSchema,
  AppStatusForgetInputSchema,
  AppStatusSummaryDataSchema,
  AppStatusSummaryInputSchema,
} from "../../packages/cloud/src/contracts/app-status";
import { defineCapabilities } from "../../packages/cloud/src/contracts/capabilities";
import type { RequestAuthority } from "../../packages/cloud/src/server";

export const appStatusDeclaration = defineCapabilities({
  protocolVersion: 2,
  appStatus: { summary: "status.summary", detail: "status.detail", forget: "status.forget" },
  queries: {
    "status.summary": {
      title: "Summary",
      description: "App traffic summary.",
      input: AppStatusSummaryInputSchema,
      data: AppStatusSummaryDataSchema,
      openWorld: false,
      run: async () => ({ ok: true, data: { data: { apps: [], otherApps: [] } } }) as const,
    },
    "status.detail": {
      title: "Detail",
      description: "App traffic detail.",
      input: AppStatusDetailInputSchema,
      data: AppStatusDetailDataSchema,
      openWorld: false,
      run: async () => ({ ok: true, data: { data: { routes: [], failedRequests: [], nextCursor: null } } }) as const,
    },
  },
  actions: {
    "status.forget": {
      title: "Forget",
      description: "Forget an offline app.",
      input: AppStatusForgetInputSchema,
      data: AppStatusForgetDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      run: async () => ({ ok: true, data: { data: { forgotten: true } } }) as const,
    },
  },
});
export const appStatusManifest = (id = "monitor") => compileCapabilities(id, appStatusDeclaration).manifest;
export const adminAuthority = (): RequestAuthority => ({
  actor: {
    kind: "user",
    user: {
      id: "00000000-0000-4000-8000-000000000001",
      uid: "admin",
      displayName: "Admin",
      givenname: "Admin",
      sn: "Example",
      provider: "local",
      profile: "user",
      roles: ["admin"],
      mail: null,
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    },
  },
  accessSubject: { type: "user", userId: "00000000-0000-4000-8000-000000000001" },
  credentialKind: "session",
  scopes: [],
});

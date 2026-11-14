import { defineCapabilities } from "@k2b/cloud";
import {
  AppStatusDetailDataSchema,
  AppStatusDetailInputSchema,
  AppStatusForgetDataSchema,
  AppStatusForgetInputSchema,
  AppStatusSummaryDataSchema,
  AppStatusSummaryInputSchema,
} from "@k2b/cloud/contracts";
import { forgetGatewayAppStatus, readGatewayAppStatusDetail, readGatewayAppStatusSummary } from "./app-status";

export const gatewayOpsCapabilities = defineCapabilities({
  protocolVersion: 2,
  appStatus: { summary: "app-status.summary", detail: "app-status.detail", forget: "app-status.forget" },
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        queries: {
          "app-status.summary": {
            title: "App-Verkehr lesen",
            description: "Liest Verkehr und Telemetrie-Links für Apps; nur für Administratoren.",
          },
          "app-status.detail": {
            title: "App-Verkehr im Detail lesen",
            description: "Liest Routen und fehlgeschlagene Anfragen einer App; nur für Administratoren.",
          },
        },
        actions: {
          "app-status.forget": {
            title: "App aus Gateway-Liste entfernen",
            description: "Entfernt eine nicht laufende App aus der Gateway-Liste und beendet ihr Offline-Audit.",
          },
        },
      },
    },
  },
  queries: {
    "app-status.summary": {
      title: "Read app traffic",
      description: "Read app traffic and telemetry links as an administrator.",
      input: AppStatusSummaryInputSchema,
      data: AppStatusSummaryDataSchema,
      openWorld: false,
      run: readGatewayAppStatusSummary,
    },
    "app-status.detail": {
      title: "Read app traffic details",
      description: "Read routes and failed requests for one app as an administrator.",
      input: AppStatusDetailInputSchema,
      data: AppStatusDetailDataSchema,
      openWorld: false,
      run: readGatewayAppStatusDetail,
    },
  },
  actions: {
    "app-status.forget": {
      code: false,
      title: "Remove app from gateway listing",
      description: "Forget an offline app and stop its offline audit.",
      input: AppStatusForgetInputSchema,
      data: AppStatusForgetDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      run: forgetGatewayAppStatus,
    },
  },
});

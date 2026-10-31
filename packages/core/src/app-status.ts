import { invokeCapability, listCapabilityCatalog } from "@k2b/cloud/capabilities/server";
import { type AppStatusDetailParams, type AppStatusSummaryParams, createAppStatusReader as createReader } from "./app-status-reader";
import { rememberAppStatusReports } from "./known-apps";

export type {
  AppStatusDetailParams,
  AppStatusDetails,
  AppStatusSummaries,
  AppStatusSummaryParams,
  AppStatusWindow,
  ProviderFailure,
  ProviderRef,
} from "./app-status-reader";

/** Create once per SSR render when reading both the list and one app's details. */
export const createAppStatusReader = () => {
  const reader = createReader({ catalog: listCapabilityCatalog, invoke: invokeCapability });
  return {
    ...reader,
    async readAppStatusSummaries(params: AppStatusSummaryParams) {
      const result = await reader.readAppStatusSummaries(params);
      await rememberAppStatusReports(result);
      return result;
    },
  };
};
export const readAppStatusSummaries = (params: AppStatusSummaryParams) => createAppStatusReader().readAppStatusSummaries(params);
export const readAppStatusDetail = (params: AppStatusDetailParams) => createAppStatusReader().readAppStatusDetail(params);

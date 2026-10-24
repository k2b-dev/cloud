import type { AppMeta } from "../contracts/app";
import { SAME_ORIGIN_PATH } from "./app-path";

/** Framework-owned management route inside a prefix the gateway already routes to this app. */
export const appAccessManagementPath = (app: Pick<AppMeta, "id" | "routes">): string => {
  const prefix = app.routes[0];
  if (!prefix || !SAME_ORIGIN_PATH.test(prefix) || /[*:?#[\]{}]/.test(prefix))
    throw new Error("Configurable app access requires a routed path prefix");
  const normalized = new URL(prefix, "https://cloud.invalid").pathname;
  if (normalized !== prefix || /%(?:2f|5c)/i.test(prefix)) throw new Error("Configurable app access requires a routed path prefix");
  return `${prefix.replace(/\/$/, "")}/_cloud/access/${encodeURIComponent(app.id)}`;
};

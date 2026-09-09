import { normalizeRedirectTo } from "@k2b/cloud/shared";

export const DEFAULT_HOME_PATH = "/app/dashboard";

export const resolveHomePath = (value: unknown): string => {
  const path = typeof value === "string" ? normalizeRedirectTo(value) : undefined;
  if (!path || path === "/" || path === "/auth" || path.startsWith("/auth/") || path === "/admin" || path.startsWith("/admin/")) {
    return DEFAULT_HOME_PATH;
  }
  return path;
};

import {
  GATEWAY_STATUS_PATH,
  MAINTENANCE_ADMIN_API_PATH,
  MaintenanceBypassSchema,
  type MaintenanceOnInput,
  type MaintenanceStatus,
  MaintenanceStatusSchema,
} from "@k2b/cloud/contracts/maintenance";

/** Calls Core's maintenance API (`/api/admin/maintenance`) from the admin page; any failure throws. */

const call = async (path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<unknown> => {
  const response = await fetch(`${MAINTENANCE_ADMIN_API_PATH}${path}`, {
    method: init.method,
    credentials: "same-origin",
    headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!response.ok) throw new Error(`maintenance ${path || "/"} answered ${response.status}`);
  return response.json();
};

const status = async (path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<MaintenanceStatus> =>
  MaintenanceStatusSchema.parse(await call(path, init));

export const maintenanceApi = {
  status: () => status("", { method: "GET" }),
  on: (input: MaintenanceOnInput) => status("/on", { method: "POST", body: input }),
  until: (until: string) => status("/until", { method: "POST", body: { until } }),
  off: () => status("/off", { method: "POST" }),
  bypass: async () => MaintenanceBypassSchema.parse(await call("/bypass", { method: "POST" })),
};

const BYPASS_ATTEMPTS = 15;
const BYPASS_WAIT_MS = 200;

const gatewayBypassConfirmed = async (): Promise<boolean> => {
  const response = await fetch(GATEWAY_STATUS_PATH, { credentials: "same-origin", cache: "no-store" }).catch(() => null);
  const body: unknown = response?.ok ? await response.json().catch(() => null) : null;
  if (!body || typeof body !== "object" || !("maintenance" in body)) return false;
  const maintenance = body.maintenance;
  return !!maintenance && typeof maintenance === "object" && "bypass" in maintenance && maintenance.bypass === true;
};

/**
 * Lets this browser past the maintenance it just started, and proves it. The gateway learns the maintenance through
 * a watch and turns the link into a cookie only once it knows it, so the link is followed (on this origin, without
 * navigating) until the gateway's status confirms the bypass for this browser — at most about three seconds. Throws
 * when it never does, so the page can say so instead of letting the next request meet the wall.
 */
export const enterThroughBypass = async (linkUrl: string, currentPath: string): Promise<void> => {
  // Same origin as the page: the cookie is host-only, and a different `app.url` host would set it elsewhere.
  const link = new URL(currentPath, window.location.origin);
  link.search = new URL(linkUrl).search;
  for (let attempt = 0; attempt < BYPASS_ATTEMPTS; attempt += 1) {
    await fetch(link.href, { credentials: "same-origin", cache: "no-store", redirect: "manual" }).catch(() => null);
    if (await gatewayBypassConfirmed()) return;
    await new Promise((resolve) => setTimeout(resolve, BYPASS_WAIT_MS));
  }
  throw new Error("the gateway did not confirm the bypass");
};

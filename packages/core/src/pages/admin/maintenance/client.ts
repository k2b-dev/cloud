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

const GATEWAY_WAIT_ATTEMPTS = 15;
const GATEWAY_WAIT_MS = 200;

/**
 * Waits, at most about three seconds, until the gateway reports the maintenance that Core just stored. The gateway
 * learns it through a watch; a bypass link it opens before then sets no cookie and would leave this browser outside.
 */
export const waitForGatewayMaintenance = async (): Promise<void> => {
  for (let attempt = 0; attempt < GATEWAY_WAIT_ATTEMPTS; attempt += 1) {
    const response = await fetch(GATEWAY_STATUS_PATH, { credentials: "same-origin", cache: "no-store" }).catch(() => null);
    const body: unknown = response?.ok ? await response.json().catch(() => null) : null;
    if (body && typeof body === "object" && "maintenance" in body && body.maintenance) return;
    await new Promise((resolve) => setTimeout(resolve, GATEWAY_WAIT_MS));
  }
};

/** The bypass link, pointed back at the page the admin is on; the gateway sets its cookie and redirects there. */
export const bypassHref = (linkUrl: string, currentPath: string): string => {
  const url = new URL(linkUrl);
  url.pathname = currentPath;
  return url.href;
};

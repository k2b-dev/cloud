// Stub: the lane driver replaces this file with the real page renderer at merge. Keep the exported interface.

export type MaintenancePageImage = { src: string /* data: URI */ };
export type MaintenancePageModel = {
  locale: "de" | "en";
  cloud: { name: string; logo?: MaintenancePageImage; accent?: string };
  timeZone: string; // IANA, for printing `until`
  statusPath: string; // "/_cloud/gateway/status"
} & (
  | { kind: "cloud"; message?: string; until?: number /* epoch ms */ }
  | {
      kind: "app";
      app: { id: string; name: string; icon?: MaintenancePageImage; accent?: string };
      reason: "updating" | "unavailable";
      homeHref?: string /* "/" on the Cloud host, omit on app domains */;
    }
);

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);

export const renderMaintenancePage = (model: MaintenancePageModel, options: { nonce: string }): string => {
  const title =
    model.kind === "cloud"
      ? model.locale === "de"
        ? "Wartungsmodus"
        : "Maintenance"
      : model.locale === "de"
        ? model.reason === "updating"
          ? `${model.app.name} wird gerade aktualisiert`
          : `${model.app.name} ist gerade nicht erreichbar`
        : model.reason === "updating"
          ? `${model.app.name} is being updated`
          : `${model.app.name} is currently unavailable`;
  return `<!doctype html><html lang="${model.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><style nonce="${escape(options.nonce)}">body{font-family:system-ui,sans-serif}</style></head><body><h1>${escape(title)}</h1>${model.kind === "cloud" && model.message ? `<p>${escape(model.message)}</p>` : ""}<script nonce="${escape(options.nonce)}">setTimeout(()=>location.reload(),30000)</script></body></html>`;
};

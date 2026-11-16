import type { CloudResourceRef } from "@k2b/cloud/contracts";

/** The SSR snapshot and live detail selection describe the same public place. */
export const gridsPageScope = (baseId: string, record: { id: string; deletedAt: string | null } | null): CloudResourceRef =>
  record && !record.deletedAt ? { type: "grids.record", id: record.id } : { type: "grids.base", id: baseId };

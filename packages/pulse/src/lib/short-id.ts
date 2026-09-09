import { crypto } from "@k2b/stdlib";
import { isUniqueViolation } from "@k2b/cloud/services";

export const SHORT_ID_LENGTH = 6;
export const SHORT_ID_REGEX = /^[0-9A-Za-z]{6}$/;

export type PulseShortIdTable = "base" | "source" | "dashboard" | "saved_query";

const MAX_ATTEMPTS = 10;

const constraintByTable: Record<PulseShortIdTable, string> = {
  base: "idx_pulse_bases_short_id",
  source: "idx_pulse_sources_short_id",
  dashboard: "idx_pulse_dashboards_short_id",
  saved_query: "idx_pulse_saved_queries_short_id",
};

export const newShortId = (): string => crypto.common.readableId(SHORT_ID_LENGTH);

export const withShortId = async <T>(table: PulseShortIdTable, write: (shortId: string) => Promise<T>): Promise<T> => {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await write(newShortId());
    } catch (error) {
      if (!isUniqueViolation(error, constraintByTable[table])) throw error;
    }
  }
  throw new Error(`Failed to allocate a short ID for Pulse ${table}`);
};

import { type AccessMember, AccessMemberSchema } from "@k2b/cloud/contracts";
import { query } from "@k2b/stdlib/solid";
import { createSignal } from "solid-js";

/** Who has access to the base of an open record, as the record panel's Access section reads it. */
export type RecordAccess = {
  readonly members: readonly AccessMember[];
  readonly state: "ready" | "loading" | "error";
  /** Starts the one read of the page, after the first paint. */
  load: () => void;
  retry: () => void;
};

/**
 * Who has access belongs to the base, not the record: it loads once, when the first record opens, and stays while
 * the page shows the base. Everyone who reads a base may read the list; the server decides the same way.
 */
export const createRecordAccess = (baseId: () => string, failedLabel: () => string): RecordAccess => {
  const [wanted, setWanted] = createSignal(false);
  const members = query.create<string, AccessMember[]>({
    source: baseId,
    enabled: wanted,
    load: async (id, { abortSignal }) => {
      const response = await fetch(`/api/grids/access/by-base/${encodeURIComponent(id)}/members`, {
        headers: { Accept: "application/json" },
        signal: abortSignal,
      });
      if (!response.ok) throw new Error(failedLabel());
      return AccessMemberSchema.array().parse(await response.json());
    },
  });
  return {
    get members() {
      return members.data() ?? [];
    },
    // A failed refresh says so instead of keeping a list that may be out of date.
    get state() {
      return members.error() ? "error" : members.data() ? "ready" : "loading";
    },
    load: () => setWanted(true),
    retry: () => void members.refresh(),
  };
};

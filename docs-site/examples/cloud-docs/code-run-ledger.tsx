import { followCodeRun, readCodeRunEntries } from "@k2b/cloud/browser/code-runs";
import { type CodeRunEntries, CodeRunEntriesSchema } from "@k2b/cloud/contracts/code-runs";
import { RunLog, type RunLogProps } from "@k2b/ui/run-log";

/** An island starts with SSR data and applies the selected run's authorized live tail. */
export function followStoreRun(
  scope: { codeId: string; runId: string },
  initial: CodeRunEntries,
  render: (snapshot: CodeRunEntries) => void,
  recover: (reason: "revoked" | "unavailable") => void,
) {
  return followCodeRun(scope, {
    initial: CodeRunEntriesSchema.parse(initial),
    snapshot: async (signal) => {
      const result = await readCodeRunEntries(scope, signal);
      if (!result.ok) throw new Error(result.error.message);
      return result.data.data;
    },
    apply: render,
    unavailable: recover,
  });
}

/** The focused UI entry renders the same RunLog contract as the main UI entry. */
export const StoreRunLog = (props: RunLogProps) => <RunLog {...props} />;

import { CAPABILITY_MAX_RESULT_BYTES, type CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { err, fail, ok } from "@k2b/stdlib";
import { ActivityInput, ShareAccessInput } from "./activity-contracts";
import {
  ActivityChainSchema,
  ActivityEntrySchema,
  ActivityIdInput,
  ActivityPageSchema,
  ShareAccessCountsSchema,
} from "./activity-transport";
import { apiError } from "./api/api-error";
import { errorMessage } from "./api/messages";
import { capabilityCall } from "./files-call";
import { filesService } from "./service";

async function read<T>(context: CapabilityExecutionContext, run: () => Promise<T>) {
  if (context.actor.kind !== "user") return fail(err.forbidden("File history requires a signed-in user."));
  try {
    const result = { data: await run() };
    // Never truncate fields or advance a page cursor past omitted entries. The caller can request a smaller page.
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > CAPABILITY_MAX_RESULT_BYTES)
      return fail({
        code: "result_too_large",
        status: 400,
        message: context.locale?.startsWith("de")
          ? "Die Antwort ist zu groß. Verkleinere die Verlaufsseite oder lies sie über die Dateien-API."
          : "The response is too large. Reduce the history page limit or read it through the Files API.",
      });
    return ok(result);
  } catch (error) {
    const { code, status } = apiError(error);
    if (status === 500 || status === 503) throw error;
    return fail({ code, status, message: errorMessage(code, context.locale) });
  }
}

const HistoryInput = ActivityInput.extend({
  baseId: ActivityInput.shape.baseId.describe("Public storage base ID; omit to search all visible bases."),
  itemId: ActivityInput.shape.itemId.describe("Filegate stable item ID, when known. Never a Cloud entry-reference ID."),
  path: ActivityInput.shape.path.describe("Current or old path relative to baseId, including missing entries. Requires baseId."),
  scope: ActivityInput.shape.scope.describe("item selects that path and relevant ancestor moves; folder includes descendants."),
  q: ActivityInput.shape.q.describe("Text matching visible names and paths, including old locations."),
  actor: ActivityInput.shape.actor.describe("Acting Cloud user UUID."),
  action: ActivityInput.shape.action.describe("Exact history action code."),
  from: ActivityInput.shape.from.describe("Inclusive ISO timestamp with timezone, filtering the effective event time."),
  to: ActivityInput.shape.to.describe("Inclusive ISO timestamp with timezone, not before from."),
  cursor: ActivityInput.shape.cursor.describe("Opaque next cursor; keep actor, address and other filters unchanged."),
  limit: ActivityInput.shape.limit.describe("Visible entries per page, 1–50; defaults to 50. Empty pages may have next."),
});
const AccessInput = ShareAccessInput.safeExtend({
  shareId: ShareAccessInput.shape.shareId.describe(
    "Public-share UUID owned by the current user, or any share for a current administrator.",
  ),
  from: ShareAccessInput.shape.from.describe("First UTC calendar date, inclusive (YYYY-MM-DD)."),
  to: ShareAccessInput.shape.to.describe("Last UTC calendar date, inclusive; window of at most 3650 days."),
  timelineAfter: ShareAccessInput.shape.timelineAfter.describe(
    "Unchanged timeline.next UTC bucket start to read older aggregates; keep the date range unchanged.",
  ),
  networkAfter: ShareAccessInput.shape.networkAfter.describe("Unchanged networks.next key to continue the shortened-network page."),
  networkLimit: ShareAccessInput.shape.networkLimit.describe("Shortened networks per page, 1–50; defaults to 50."),
});

export const activityQueries = {
  "activity.get": {
    title: "Read one file history event",
    description:
      "Read an activity UUID with the same current side-by-side permissions as activity.list. A hidden or missing event returns not_found. Saved snapshots never grant current access.",
    input: ActivityIdInput,
    data: ActivityEntrySchema,
    openWorld: false,
    run: (input: { activityId: string }, context: CapabilityExecutionContext) =>
      read(context, () => filesService.activityEntry({ ...capabilityCall(context), requestAbort: context.signal }, input)),
  },
  "activity.list": {
    title: "Read file history",
    description:
      "Read one authorized history page for a file, folder or base; search visible names and old paths with q. Filters actor/action/from/to and the opaque cursor must stay unchanged between pages. At most 50 visible entries, 500 candidates per call and 200 search matches; empty pages can have a next cursor. Snapshots do not grant current access.",
    input: HistoryInput,
    data: ActivityPageSchema,
    openWorld: false,
    run: (input: Parameters<typeof filesService.activity>[1], context: CapabilityExecutionContext) =>
      read(context, () => filesService.activity({ ...capabilityCall(context), requestAbort: context.signal }, input)),
  },
  "activity.chain": {
    title: "Follow a file movement",
    description:
      "Follow up to 20 authorized movement steps from an activity ID. An endpoint is returned only after fresh current access checks. probable is evidence without stable identity; historyComplete is always false. This read never moves or restores files.",
    input: ActivityIdInput,
    data: ActivityChainSchema,
    openWorld: false,
    run: (input: { activityId: string }, context: CapabilityExecutionContext) =>
      read(context, () => filesService.movementChain({ ...capabilityCall(context), requestAbort: context.signal }, input)),
  },
  "share.access": {
    title: "Read public-link access counts",
    description:
      "Read page, download and failed-password counts for one public share and an inclusive UTC date range. Only its creator or a current administrator may read these counts. Returns up to 50 shortened networks ordered by page plus download usage and up to 50 latest UTC hour/day aggregates; timelineAfter continues older aggregates. Hourly network identities cover only the last 30 days; rolled-up totals have no network identities. Top-level and per-bucket pageNetworks count only networks with page views, or null when unavailable; daily buckets always return null. networks.known and each bucket's knownNetworks include other access kinds. A download count does not prove a completed transfer.",
    input: AccessInput,
    data: ShareAccessCountsSchema,
    openWorld: false,
    run: (input: ShareAccessInput, context: CapabilityExecutionContext) =>
      read(context, () => filesService.shareAccess({ ...capabilityCall(context), requestAbort: context.signal }, input)),
  },
};

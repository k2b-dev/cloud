import { AccountIdentityError } from "@k2b/cloud/services";
import { FilegateError } from "@k2b/filegate";
import type { FileEntry } from "../contracts";
import type { Binding } from "../data/bases";
import { type ListingFactRow, type ListingFactsInput, type ListingFactTarget, readListingFacts } from "../data/listing-facts";
import { type ActivityReadBudget, withActivityReadBudget } from "./activity-read-budget";
import type { ActivityReadCall, ActivityReaderDependencies, HistoryAccess } from "./activity-reader";
import { FilesError } from "./errors";

type Dependencies = Pick<ActivityReaderDependencies, "requestContext" | "displayNames"> & {
  data?: (input: ListingFactsInput) => PromiseLike<ListingFactRow[]> & { cancel?(): void };
};
type Page = { binding: Binding; baseId: string; folder: string; items: ListingFactTarget[] };
type ReadContext = Awaited<ReturnType<ActivityReaderDependencies["requestContext"]>>;

/** Folder authorization covers local Cloud children. POSIX history and foreign admin snapshots stay hidden.
 * This reader never exposes a foreign snapshot, so it must never bypass recordAdminRead by resolving its author.
 */
export function createListingFactsReader(deps: Dependencies) {
  return async (
    call: Pick<ActivityReadCall, "actor" | "requestAbort">,
    page: Page,
  ): Promise<Map<string, NonNullable<FileEntry["facts"]>>> =>
    withActivityReadBudget(call.requestAbort, async (budget) => {
      if (!page.items.length) return new Map();
      const context = await budget.run(() => deps.requestContext(call.actor, budget));
      if (context.config.unreadable) throw new FilesError("configuration_unreadable", 409);
      const binding = page.binding;
      let history = false;
      if (context.historyAvailable && binding.area === "cloud" && context.allowedBindingIds.includes(binding.id)) {
        const current = await authorize(context.readOnlyAuthorized, page, budget);
        history =
          current !== null &&
          binding.lifecycle === "active" &&
          current.state.config.url === context.config.url &&
          current.inspection.binding?.id === binding.id &&
          current.inspection.binding.root === binding.root &&
          current.inspection.binding.path === binding.path &&
          current.inspection.summary.id === page.baseId &&
          current.target === (page.folder ? `${binding.path}/${page.folder}` : binding.path) &&
          current.node.path === current.target;
      }
      const pending = (deps.data ?? readListingFacts)({
        bindingId: binding.id,
        basePath: binding.path,
        root: binding.root,
        serverUrl: context.config.url,
        userId: context.userId,
        history,
        items: page.items,
      });
      const rows = await budget.run(
        () => pending,
        () => pending.cancel?.(),
      );
      // Even an injected data source cannot resolve or project names outside this reader's authority.
      const ids = history ? [...new Set(rows.flatMap((row) => (row.author_id ? [row.author_id] : [])))] : [];
      const names = ids.length
        ? await budget.run(() => deps.displayNames(ids.map((userId) => ({ principal: { type: "user" as const, userId } }))))
        : [];
      const byId = new Map(
        names.flatMap((row) => (row.principal.type === "user" ? [[row.principal.userId, row.displayName] as const] : [])),
      );
      return new Map(
        rows.map((row) => {
          const name = history && row.author_id ? byId.get(row.author_id) : undefined;
          return [
            row.path,
            { author: row.author_id && name !== undefined ? { userId: row.author_id, name } : null, links: Number(row.links) },
          ];
        }),
      );
    });
}

async function authorize(read: ReadContext["readOnlyAuthorized"], page: Page, budget: ActivityReadBudget): Promise<HistoryAccess | null> {
  try {
    return await budget.run(() => read(page.baseId, page.folder));
  } catch (error) {
    if (
      (error instanceof FilesError || error instanceof FilegateError || error instanceof AccountIdentityError) &&
      [403, 404].includes(error.status)
    )
      return null;
    throw error;
  }
}

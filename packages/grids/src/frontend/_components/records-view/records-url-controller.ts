import { batch, onCleanup, onMount } from "solid-js";
import type { RecordQuery } from "../../../contracts";
import { resolveEffectiveQueryFromStored } from "./effective-query";
import type { FilterStatements } from "./filter-statements";
import { buildRecordsUrl, parseRecordsState, type RecordsState, recordsPath, type UrlPathContext } from "./query-url";

type RecordsHistoryState = {
  state: Omit<RecordsState, "query"> & { query: RecordQuery };
  adminMode: boolean;
};

export const recordsHistoryStateFromUrl = (
  href: string,
  canUseEditMode: boolean,
  activeRecordQuery: RecordQuery | null = null,
  statements?: FilterStatements,
): RecordsHistoryState => {
  const url = new URL(href, "http://grids.local");
  const parsed = parseRecordsState(url.searchParams, statements);
  const { source: _source, search, ...query } = resolveEffectiveQueryFromStored(parsed, activeRecordQuery);
  return {
    state: {
      ...parsed,
      query,
      search: {
        q: search?.q ?? "",
        fieldIds: search?.fieldIds ?? [],
        override: parsed.search.override,
      },
    },
    adminMode: canUseEditMode && url.searchParams.get("edit") === "true",
  };
};

export const applyRecordsHistoryUrl = (options: {
  href: string;
  ownedPathname: string;
  canUseEditMode: boolean;
  activeRecordQuery: RecordQuery | null;
  statements?: FilterStatements;
  beforeApply: () => void;
  apply: (history: RecordsHistoryState) => void;
}): boolean => {
  const url = new URL(options.href, "http://grids.local");
  if (url.pathname !== options.ownedPathname) return false;

  batch(() => {
    options.beforeApply();
    options.apply(recordsHistoryStateFromUrl(url.href, options.canUseEditMode, options.activeRecordQuery, options.statements));
  });
  return true;
};

type RecordsUrlControllerOptions = {
  path: UrlPathContext;
  activeRecordQuery: RecordQuery | null;
  state: () => RecordsState;
  adminMode: () => boolean;
  canUseEditMode: () => boolean;
  beforePopState: () => void;
  applyPopState: (history: RecordsHistoryState) => void;
  /** The FilterBar's statements of a table page; the address holds them as their own parameters. */
  statements?: () => FilterStatements | undefined;
};

export const createRecordsUrlController = (options: RecordsUrlControllerOptions) => {
  const sync = ({ replace }: { replace: boolean }) => {
    if (typeof window === "undefined") return;
    const next = new URL(
      buildRecordsUrl(options.path, options.state(), options.activeRecordQuery, options.statements?.()),
      window.location.origin,
    );
    if (options.adminMode()) next.searchParams.set("edit", "true");
    else next.searchParams.delete("edit");
    const href = `${next.pathname}${next.search}`;
    if (href === window.location.pathname + window.location.search) return;
    if (replace) window.history.replaceState(null, "", href);
    else window.history.pushState(null, "", href);
  };
  const ownedPathname = recordsPath(options.path);

  onMount(() => {
    if (typeof window === "undefined") return;
    const previousRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";

    const applyCurrentUrl = () => {
      applyRecordsHistoryUrl({
        href: window.location.href,
        ownedPathname,
        canUseEditMode: options.canUseEditMode(),
        activeRecordQuery: options.activeRecordQuery,
        statements: options.statements?.(),
        beforeApply: options.beforePopState,
        apply: options.applyPopState,
      });
    };
    window.addEventListener("popstate", applyCurrentUrl);
    onCleanup(() => {
      window.removeEventListener("popstate", applyCurrentUrl);
      window.history.scrollRestoration = previousRestoration;
    });
  });

  return { sync };
};

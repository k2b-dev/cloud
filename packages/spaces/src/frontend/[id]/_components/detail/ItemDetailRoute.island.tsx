import type { DateContext } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import { AppWorkspace, Button, Placeholder, prompts } from "@k2b/ui";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { SpaceColumn, SpaceTag, SpaceWormhole } from "@/contracts";
import { readResponseError } from "../../../lib/response";
import { useSpaceMessages } from "../../messages";
import {
  publishSpacesDetailState,
  SPACES_DETAIL_NAVIGATION_EVENT,
  type SpacesDetailNavigation,
  shouldInvalidateSpacesDetail,
  subscribeToSpacesDataInvalidation,
} from "../workspace/workspace-events";
import type { SpaceItemDetail } from "../workspace/workspace-types";
import ItemDetailPanel from "./ItemDetailPanel";

type Props = {
  spaceId: string;
  initialSource: string;
  currentUserId: string;
  columns: SpaceColumn[];
  tags: SpaceTag[];
  wormholes: SpaceWormhole[];
  initialDetail: SpaceItemDetail | null;
  dateConfig?: DateContext;
  canWrite: boolean;
  mailIntegrationAvailable: boolean;
};

type DetailHistory = "push" | "replace" | "none";
type DetailSnapshot = { source: string; detail: SpaceItemDetail | null; notFound: boolean };
type PendingNavigation = { id: number; source: string; history: DetailHistory; started: boolean };

class DetailAccessChangedError extends Error {}

const detailRequest = (href: string) => {
  const url = new URL(href, "http://spaces.local");
  return {
    itemId: url.searchParams.get("item"),
    occurrenceId: url.searchParams.get("occurrence"),
  };
};

// List filters and calendar position are navigation state, not editor identity.
const detailSource = (href: string) => {
  const url = new URL(href, "http://spaces.local");
  const request = detailRequest(href);
  url.search = "";
  if (request.itemId) {
    url.searchParams.set("item", request.itemId);
    if (request.occurrenceId) url.searchParams.set("occurrence", request.occurrenceId);
  }
  return `${url.pathname}${url.search}`;
};

const canonicalDetailHref = (source: string, detail: SpaceItemDetail) => {
  const request = detailRequest(source);
  if (!detail.recurringContext?.isOverride || detail.item.id === request.itemId) return source;
  const url = new URL(source, "http://spaces.local");
  url.searchParams.set("item", detail.item.id);
  return `${url.pathname}${url.search}`;
};

const detailBaseHref = (source: string) => {
  const url = new URL(source, "http://spaces.local");
  url.searchParams.delete("item");
  url.searchParams.delete("occurrence");
  return `${url.pathname}${url.search}`;
};

const detailState = (detail: SpaceItemDetail | null) => {
  if (!detail) return { itemId: null, occurrenceId: null, selectionId: null };
  const recurring = detail.recurringContext;
  return {
    itemId: detail.item.id,
    occurrenceId: recurring?.recurrenceId ?? null,
    selectionId: recurring
      ? recurring.isOverride
        ? detail.item.id
        : `${recurring.seriesItemId}:${recurring.recurrenceId}`
      : detail.item.id,
  };
};

const writeHistory = (href: string, history: DetailHistory) => {
  if (history === "replace") window.history.replaceState(null, "", href);
  else if (history === "push") window.history.pushState(null, "", href);
  else if (`${window.location.pathname}${window.location.search}` !== href) window.history.replaceState(null, "", href);
};

export default function ItemDetailRoute(props: Props) {
  const t = useSpaceMessages();
  const initialSource = props.initialDetail ? canonicalDetailHref(props.initialSource, props.initialDetail) : props.initialSource;
  const initialRequest = detailRequest(props.initialSource);
  const [source, setSource] = createSignal(initialSource);
  const [pending, setPending] = createSignal<PendingNavigation | null>(null);
  let nextNavigationId = 0;
  let committedSource = initialSource;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  const wormholesQuery = query.create<string, SpaceWormhole[], { cursor: string | null }>({
    source: () => props.spaceId,
    initial: { source: props.spaceId, data: props.wormholes },
    enabled: () => props.canWrite,
    load: async (spaceId, { abortSignal }) => {
      const response = await apiClient[":id"].wormholes.$get({ param: { id: spaceId } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await readResponseError(response, t.loadWormholesFailed));
      return response.json();
    },
    subscribe: ({ invalidate }) =>
      subscribeToSpacesDataInvalidation(["wormholes"], (invalidation) => (props.canWrite ? invalidate(invalidation) : Promise.resolve())),
  });

  const detailQuery = query.create<string, DetailSnapshot, { cursor: string | null }>({
    source: () => detailSource(source()),
    initial:
      props.initialDetail || !initialRequest.itemId
        ? {
            source: detailSource(initialSource),
            data: { source: detailSource(initialSource), detail: props.initialDetail, notFound: false },
          }
        : undefined,
    enabled: () => detailRequest(source()).itemId !== null,
    load: async (href, { abortSignal }) => {
      const request = detailRequest(href);
      if (!request.itemId) return { source: href, detail: null, notFound: false };
      const response = await apiClient[":id"].items[":itemId"].detail.$get(
        {
          param: { id: props.spaceId, itemId: request.itemId },
          query: request.occurrenceId ? { recurrence_id: request.occurrenceId } : {},
        },
        { init: { signal: abortSignal } },
      );
      if (response.status === 401 || response.status === 403) throw new DetailAccessChangedError(t.workspaceAccessChanged);
      if (response.status === 404) return { source: href, detail: null, notFound: true };
      if (!response.ok) throw new Error(await readResponseError(response, t.loadItemFailed));
      return { source: href, detail: await response.json(), notFound: false };
    },
    subscribe: ({ invalidate }) =>
      subscribeToSpacesDataInvalidation(["detail"], async (invalidation) => {
        while (!disposed) {
          const requestedSource = detailSource(source());
          const itemId = detailRequest(requestedSource).itemId;
          // A closed panel has no snapshot to refresh. Never wait on its disabled query.
          if (!itemId || !shouldInvalidateSpacesDetail(itemId, invalidation.itemId)) return;
          try {
            await invalidate(invalidation);
            return;
          } catch (error) {
            // Selection changes supersede coverage; cover the new selection or close.
            if (disposed || requestedSource === detailSource(source())) throw error;
          }
        }
      }),
  });

  const hasDetailSelection = () => detailRequest(source()).itemId !== null;
  const currentDetail = () => {
    const snapshot = detailQuery.data();
    return hasDetailSelection() && snapshot?.source === detailSource(source()) && !snapshot.notFound ? snapshot.detail : null;
  };

  const restoreCommitted = (request: PendingNavigation, error: Error) => {
    if (pending()?.id !== request.id) return;
    setPending(null);
    setSource(committedSource);
    if (request.history === "none") window.history.replaceState(null, "", committedSource);
    if (error instanceof DetailAccessChangedError) window.location.reload();
    else prompts.error(error.message);
  };

  createEffect(() => {
    const request = pending();
    if (request && (detailQuery.loading() || detailQuery.refreshing())) request.started = true;
    const snapshot = detailQuery.data();

    if (request && snapshot?.source === detailSource(request.source) && !detailQuery.stale()) {
      if (snapshot.notFound) {
        restoreCommitted(request, new Error(t.itemNotFound));
        return;
      }
      const href = snapshot.detail ? canonicalDetailHref(request.source, snapshot.detail) : request.source;
      if (href !== request.source) {
        setPending({ ...request, source: href, started: false });
        setSource(href);
        return;
      }
      setPending(null);
      committedSource = href;
      writeHistory(href, request.history);
      publishSpacesDetailState(detailState(snapshot.detail));
      return;
    }

    const error = detailQuery.error();
    if (request?.started && error) {
      restoreCommitted(request, error);
      return;
    }

    if (!request && snapshot?.source === detailSource(source())) {
      if (snapshot.notFound) {
        const baseHref = detailBaseHref(source());
        committedSource = baseHref;
        setSource(baseHref);
        window.history.replaceState(null, "", baseHref);
        publishSpacesDetailState(detailState(null));
      } else {
        publishSpacesDetailState(detailState(snapshot.detail));
      }
    }
  });

  const navigateDetail = (href: string, history: DetailHistory) => {
    const request = detailRequest(href);
    const current = currentDetail();
    if (!request.itemId || (current && detailSource(href) === detailSource(source()))) {
      setPending(null);
      setSource(href);
      committedSource = href;
      writeHistory(href, history);
      publishSpacesDetailState(detailState(request.itemId ? current : null));
      return;
    }
    setPending({ id: ++nextNavigationId, source: href, history, started: false });
    setSource(href);
  };

  onMount(() => {
    const initial = currentDetail();
    if (initial) {
      writeHistory(initialSource, "none");
      publishSpacesDetailState(detailState(initial));
    } else {
      publishSpacesDetailState(detailState(null));
    }

    const onNavigate = (event: Event) => {
      const request = (event as CustomEvent<SpacesDetailNavigation>).detail;
      if (!request) return;
      const selection = pending();
      if (request.reconcile && selection && selection.history !== "none") {
        // A view response can retain or clear its old selection. Rebase, rather
        // than cancel, a newer item click whose detail read has not completed yet.
        // History restoration itself remains authoritative.
        const target = new URL(request.href, window.location.origin);
        const selected = detailRequest(selection.source);
        target.searchParams.set("item", selected.itemId!);
        if (selected.occurrenceId) target.searchParams.set("occurrence", selected.occurrenceId);
        else target.searchParams.delete("occurrence");
        const href = `${target.pathname}${target.search}`;
        committedSource = request.href;
        setPending({ ...selection, source: href });
        setSource(href);
        return;
      }
      navigateDetail(request.href, request.history ?? "push");
    };
    const onPopState = () => navigateDetail(`${window.location.pathname}${window.location.search}`, "none");
    window.addEventListener(SPACES_DETAIL_NAVIGATION_EVENT, onNavigate);
    window.addEventListener("popstate", onPopState);
    onCleanup(() => {
      window.removeEventListener(SPACES_DETAIL_NAVIGATION_EVENT, onNavigate);
      window.removeEventListener("popstate", onPopState);
    });
  });

  const detail = currentDetail;
  const scrollKey = () =>
    `spaces-detail-${props.spaceId}-${detail()?.item.id ?? "empty"}-${detail()?.recurringContext?.recurrenceId ?? "series"}`;

  return (
    <AppWorkspace.Detail id="space-detail-panel" open={hasDetailSelection()} viewTransitionName="space-detail-panel-shell">
      <div class="h-full min-h-0 flex-1">
        <Show
          when={detail()}
          fallback={
            detailQuery.error() ? (
              <Placeholder
                state="error"
                title={t.couldNotLoadDetails}
                description={detailQuery.error()!.message}
                action={
                  <Button type="button" variant="secondary" size="sm" onClick={() => void detailQuery.refresh()}>
                    {t.retry}
                  </Button>
                }
              />
            ) : hasDetailSelection() ? (
              <Placeholder state="loading" title={t.loadingDetails} />
            ) : (
              <Placeholder icon="ti ti-click" description={<>{t.selectItemForDetails}</>} />
            )
          }
        >
          {(current) => (
            <ItemDetailPanel
              item={current().item}
              columns={props.columns}
              tags={props.tags}
              wormholes={wormholesQuery.data() ?? props.wormholes}
              spaceId={props.spaceId}
              baseUrl={detailBaseHref(source())}
              currentUserId={props.currentUserId}
              initialCommentsPage={current().comments}
              commentTarget={current().commentTarget}
              recurringContext={current().recurringContext}
              references={current().references}
              attachments={current().attachments}
              checklist={current().checklist}
              blockedBy={current().blockedBy}
              blocks={current().blocks}
              dateConfig={props.dateConfig}
              canWrite={props.canWrite}
              mailIntegrationAvailable={props.mailIntegrationAvailable}
              scrollPreserveKey={scrollKey()}
            />
          )}
        </Show>
      </div>
    </AppWorkspace.Detail>
  );
}

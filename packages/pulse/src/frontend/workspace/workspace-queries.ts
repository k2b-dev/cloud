import type { ResourceApiKey } from "@k2b/cloud/access/ui";
import { query } from "@k2b/stdlib/solid";
import { type Accessor, createMemo } from "solid-js";
import type { FetchMinute, PulseBase, PulseSource, PulseSourceScrape, SourceFigures } from "../../contracts";
import { jsonFetch } from "../http";
import { SOURCES_PAGE } from "./source-page";
import type { PulseWorkspaceProps } from "./types";

type SourceDetail = {
  baseId: string;
  sourceId: string;
  scrapes: PulseSourceScrape[];
  apiKeys: ResourceApiKey[];
  /** A metrics source's last hour per minute; push sources have none. */
  minutes: FetchMinute[];
};

export const createPulseWorkspaceQueries = (
  props: PulseWorkspaceProps & { initialSearch?: string },
  selectedSourceId: Accessor<string>,
  loadSources?: Accessor<boolean>,
  /** The words the source list is searched for on the server; settled, not every keystroke. */
  search?: Accessor<string>,
) => {
  const baseId = props.initialBaseId;
  const bases = query.create({
    source: () => "bases",
    initial: props.initialQueryCoverage.bases ? { source: "bases", data: props.initialBases } : undefined,
    load: (_, { abortSignal }) => jsonFetch<PulseBase[]>("/api/pulse/bases", { signal: abortSignal }),
  });
  // One page of sources at a time, searched on the server; more pages come on request. The figures above the list
  // cover all sources, so the list never needs all of them.
  type SourcePage = { offset: number; items: PulseSource[] };
  const pageSource = () => ({ baseId, q: (search?.() ?? "").trim() });
  const pages = query.createInfinite<{ baseId: string; q: string }, SourcePage, number>({
    enabled: () => loadSources?.() ?? props.initialRouteState.view === "sources",
    source: pageSource,
    isSameSource: (left, right) => left.baseId === right.baseId && left.q === right.q,
    initial: props.initialQueryCoverage.baseData
      ? { source: { baseId, q: (props.initialSearch ?? "").trim() }, pages: [{ offset: 0, items: props.initialSources }] }
      : undefined,
    loadPage: async (page, { cursor, abortSignal }) => {
      const offset = cursor ?? 0;
      const query = new URLSearchParams({ limit: String(SOURCES_PAGE), offset: String(offset) });
      if (page.q) query.set("q", page.q);
      const items = await jsonFetch<PulseSource[]>(`/api/pulse/bases/${page.baseId}/sources?${query}`, { signal: abortSignal });
      return { offset, items };
    },
    getNextCursor: (page) => (page.items.length === SOURCES_PAGE ? page.offset + SOURCES_PAGE : null),
  });
  const baseData = {
    ...pages,
    data: (): PulseSource[] | undefined => (pages.pages().length ? pages.pages().flatMap((page) => page.items) : undefined),
  };
  const figures = query.create({
    enabled: () => loadSources?.() ?? props.initialRouteState.view === "sources",
    source: () => baseId,
    initial: props.initialFigures ? { source: baseId, data: props.initialFigures } : undefined,
    load: (id, { abortSignal }) => jsonFetch<SourceFigures>(`/api/pulse/bases/${id}/sources/figures`, { signal: abortSignal }),
  });
  const source = createMemo(() => ({
    baseId,
    sourceId: selectedSourceId(),
    kind: baseData.data()?.find((item) => item.id === selectedSourceId())?.kind,
  }));
  const initialId = props.initialRouteState.sourceId;
  const sourceDetail = query.create({
    source,
    initial:
      initialId && props.initialQueryCoverage.sourceDetail
        ? {
            source: { baseId, sourceId: initialId, kind: props.initialSources.find((item) => item.id === initialId)?.kind },
            data: {
              baseId,
              sourceId: initialId,
              scrapes: props.initialSourceScrapes[initialId] ?? [],
              apiKeys: props.initialSourceApiKeys[initialId] ?? [],
              minutes: props.initialSourceMinutes?.[initialId] ?? [],
            },
          }
        : undefined,
    enabled: () => Boolean(selectedSourceId()),
    isSameSource: (a, b) => a.baseId === b.baseId && a.sourceId === b.sourceId && a.kind === b.kind,
    load: async ({ baseId, sourceId, kind }, { abortSignal }): Promise<SourceDetail> => {
      const path = `/api/pulse/bases/${baseId}/sources/${sourceId}`;
      const [scrapes, apiKeys, minutes] = await Promise.all([
        jsonFetch<PulseSourceScrape[]>(`${path}/scrapes`, { signal: abortSignal }),
        kind === "http_ingest" ? jsonFetch<ResourceApiKey[]>(`${path}/api-keys`, { signal: abortSignal }) : Promise.resolve([]),
        kind === "metrics" ? jsonFetch<FetchMinute[]>(`${path}/minutes`, { signal: abortSignal }) : Promise.resolve([]),
      ]);
      return { baseId, sourceId, scrapes, apiKeys, minutes };
    },
  });
  const currentDetail = () => {
    const detail = sourceDetail.data();
    return detail?.baseId === baseId && detail.sourceId === selectedSourceId() ? detail : undefined;
  };
  return { bases, baseData, figures, sourceDetail, currentDetail };
};

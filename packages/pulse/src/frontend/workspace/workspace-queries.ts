import type { ResourceApiKey } from "@k2b/cloud/access/ui";
import { query } from "@k2b/stdlib/solid";
import { type Accessor, createMemo } from "solid-js";
import type { PulseBase, PulseSource, PulseSourceScrape } from "../../contracts";
import { jsonFetch } from "../http";
import type { PulseWorkspaceProps } from "./types";

type SourceDetail = { baseId: string; sourceId: string; scrapes: PulseSourceScrape[]; apiKeys: ResourceApiKey[] };

export const createPulseWorkspaceQueries = (props: PulseWorkspaceProps, selectedSourceId: Accessor<string>) => {
  const baseId = props.initialBaseId;
  const bases = query.create({
    source: () => "bases",
    initial: props.initialQueryCoverage.bases ? { source: "bases", data: props.initialBases } : undefined,
    load: (_, { abortSignal }) => jsonFetch<PulseBase[]>("/api/pulse/bases", { signal: abortSignal }),
  });
  const baseData = query.create({
    source: () => baseId,
    initial: props.initialQueryCoverage.baseData ? { source: baseId, data: props.initialSources } : undefined,
    load: (id, { abortSignal }) => jsonFetch<PulseSource[]>(`/api/pulse/bases/${id}/sources`, { signal: abortSignal }),
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
            },
          }
        : undefined,
    enabled: () => Boolean(selectedSourceId()),
    isSameSource: (a, b) => a.baseId === b.baseId && a.sourceId === b.sourceId && a.kind === b.kind,
    load: async ({ baseId, sourceId, kind }, { abortSignal }): Promise<SourceDetail> => {
      const path = `/api/pulse/bases/${baseId}/sources/${sourceId}`;
      const [scrapes, apiKeys] = await Promise.all([
        jsonFetch<PulseSourceScrape[]>(`${path}/scrapes`, { signal: abortSignal }),
        kind === "http_ingest" ? jsonFetch<ResourceApiKey[]>(`${path}/api-keys`, { signal: abortSignal }) : Promise.resolve([]),
      ]);
      return { baseId, sourceId, scrapes, apiKeys };
    },
  });
  const currentDetail = () => {
    const detail = sourceDetail.data();
    return detail?.baseId === baseId && detail.sourceId === selectedSourceId() ? detail : undefined;
  };
  return { bases, baseData, sourceDetail, currentDetail };
};

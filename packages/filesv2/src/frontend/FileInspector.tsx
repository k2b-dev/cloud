import { query } from "@k2b/stdlib/solid";
import { Button, DescriptionList, DetailPanel, Format, IconButton, Placeholder, prompts } from "@k2b/ui";
import { Show } from "solid-js";
import { apiClient } from "../api/client";
import type { BaseSummary, EntryResult, FileEntry } from "../contracts";
import { useBrowserMessages } from "./browser-messages";
import FilePreview from "./FilePreview";
import { apiFailure, fileIcon } from "./file-preview";
import { useFilesMessages } from "./messages";

export default function FileInspector(props: {
  base: BaseSummary;
  selected: readonly FileEntry[];
  paths: readonly string[];
  initial?: EntryResult | null;
  onClose: () => void;
  onOpen: (entry: FileEntry) => void;
  onDownload: (entries: readonly FileEntry[]) => void;
}) {
  const t = useBrowserMessages();
  const f = useFilesMessages();
  const source = () =>
    JSON.stringify([
      props.base.id,
      props.paths.length === 1 ? props.paths[0] : null,
      props.selected.find((entry) => entry.path === props.paths[0])?.modified,
    ]);
  const initial =
    props.initial && props.paths.length === 1 && props.initial.entry.path === props.paths[0]
      ? { source: source(), data: { key: source(), result: props.initial } }
      : undefined;
  const details = query.create({
    source,
    initial,
    enabled: () => props.paths.length === 1,
    load: async (key, { abortSignal }) => {
      const response = await apiClient.bases[":baseId"].entry.$get(
        { param: { baseId: props.base.id }, query: { path: props.paths[0]! } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) return apiFailure(response, t().detailsFailed);
      return { key, result: await response.json() };
    },
  });
  const entry = () => (details.data()?.key === source() && !details.error() ? details.data()?.result.entry : null);
  const close = (
    <IconButton size="sm" variant="ghost" label={t().close} onClick={props.onClose}>
      <i class="ti ti-x" aria-hidden="true" />
    </IconButton>
  );
  const expand = (item: FileEntry) =>
    prompts.dialog(() => <FilePreview baseId={props.base.id} entry={item} onDownload={() => props.onDownload([item])} />, {
      title: item.name,
      size: "large",
    });
  return (
    <DetailPanel>
      <Show
        when={props.paths.length > 1}
        fallback={
          <Show
            when={entry()}
            fallback={
              <>
                <DetailPanel.Header title={t().details} actions={close} />
                <DetailPanel.Body>
                  <Placeholder
                    state={details.error() ? "error" : "loading"}
                    description={details.error() ? t().detailsFailed : t().loadingDetails}
                    action={details.error() ? <Button onClick={() => details.refresh()}>{t().retry}</Button> : undefined}
                  />
                </DetailPanel.Body>
              </>
            }
          >
            {(item) => (
              <>
                <DetailPanel.Header
                  icon={fileIcon(item())}
                  title={<span class="break-all">{item().name}</span>}
                  subtitle={item().directory ? t().folder : t().file}
                  actions={close}
                  primaryActions={
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => (item().directory ? props.onOpen(item()) : props.onDownload([item()]))}
                    >
                      <i class={item().directory ? "ti ti-folder-open" : "ti ti-download"} aria-hidden="true" />
                      {item().directory ? t().open : f().download}
                    </Button>
                  }
                />
                <DetailPanel.Body scrollPreserveKey={`filesv2-inspector:${props.base.id}:${item().path}`}>
                  <Show when={!item().directory}>
                    <DetailPanel.Section
                      title={t().preview}
                      actions={
                        <IconButton size="sm" variant="ghost" label={t().expand} onClick={() => expand(item())}>
                          <i class="ti ti-arrows-maximize" aria-hidden="true" />
                        </IconButton>
                      }
                    >
                      <Show keyed when={`${props.base.id}:${item().path}:${item().modified}`}>
                        <FilePreview baseId={props.base.id} entry={item()} onDownload={() => props.onDownload([item()])} />
                      </Show>
                    </DetailPanel.Section>
                  </Show>
                  <DetailPanel.Summary title={t().info}>
                    <DescriptionList
                      layout="rows"
                      size="sm"
                      items={[
                        {
                          term: t().location,
                          description: (
                            <span class="break-all">
                              {props.base.name} / {item().path}
                            </span>
                          ),
                        },
                        { term: f().modified, description: <Format.DateTime value={item().modified} /> },
                        ...(!item().directory ? [{ term: f().size, description: <Format.Bytes value={item().size} /> }] : []),
                        { term: t().origin, description: f()[props.base.area] },
                      ]}
                    />
                  </DetailPanel.Summary>
                </DetailPanel.Body>
              </>
            )}
          </Show>
        }
      >
        <DetailPanel.Header icon="ti ti-stack" title={t().selected(props.paths.length)} actions={close} />
        <DetailPanel.Body>
          <DetailPanel.Summary title={t().selection}>
            <DescriptionList
              layout="rows"
              size="sm"
              items={[
                { term: t().files, description: props.selected.filter((entry) => !entry.directory).length },
                { term: t().folders, description: props.selected.filter((entry) => entry.directory).length },
                {
                  term: t().knownBytes,
                  description: (
                    <Format.Bytes value={props.selected.filter((entry) => !entry.directory).reduce((sum, entry) => sum + entry.size, 0)} />
                  ),
                },
              ]}
            />
            <Show when={props.selected.some((entry) => entry.directory)}>
              <p class="text-sm text-dimmed">{t().unknownFolders}</p>
              <p class="text-sm text-dimmed">{t().filesOnly}</p>
            </Show>
          </DetailPanel.Summary>
        </DetailPanel.Body>
      </Show>
    </DetailPanel>
  );
}

import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { Button, ButtonLink, DataTable, Format, InlineGuidance, Placeholder } from "@k2b/ui";
import { For, onCleanup, Show } from "solid-js";
import { apiClient } from "../api/client";
import { type DirectoryResult, ErrorSchema, type FileEntry } from "../contracts";
import { useFilesMessages } from "./messages";
import { filesUrl, pathCrumbs } from "./urls";

export default function Browser(props: {
  directory: DirectoryResult;
  after?: string;
  onNavigate: (event: LinkNavigateEvent) => Promise<void>;
}) {
  const t = useFilesMessages();
  const download = mutation.create({
    mutation: async (path: string, { abortSignal }) => {
      const response = await apiClient.bases[":baseId"].download.$post(
        { param: { baseId: props.directory.base.id }, json: { path } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) {
        const error = ErrorSchema.safeParse(await response.json());
        throw new Error(error.success ? error.data.message : t().downloadFailed);
      }
      return response.json();
    },
    onSuccess: (lease) => {
      window.location.assign(lease.url);
    },
  });
  onCleanup(() => download.abort());
  const startDownload = (path: string) => {
    if (!download.loading()) void download.mutate(path);
  };
  const columns = () => [
    { id: "name", header: t().name, value: "name" as const },
    { id: "size", header: t().size, align: "right" as const },
    { id: "modified", header: t().modified },
    { id: "actions", header: t().actions, align: "right" as const },
  ];
  return (
    <section class="flex min-h-0 min-w-0 flex-1 flex-col gap-3" aria-label={props.directory.base.name}>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <nav aria-label={t().breadcrumbs}>
          <ol class="flex flex-wrap items-center gap-1">
            <li>
              <ButtonLink
                navigation="enhanced"
                onNavigate={props.onNavigate}
                size="sm"
                variant="text"
                href={filesUrl(props.directory.base.id)}
                aria-current={!props.directory.path ? "page" : undefined}
              >
                {props.directory.base.name}
              </ButtonLink>
            </li>
            <For each={pathCrumbs(props.directory.path)}>
              {(crumb) => (
                <li class="flex min-w-0 items-center gap-1">
                  <span aria-hidden="true" class="text-dimmed">
                    /
                  </span>
                  <ButtonLink
                    navigation="enhanced"
                    onNavigate={props.onNavigate}
                    size="sm"
                    variant="text"
                    wrap
                    href={filesUrl(props.directory.base.id, crumb.path)}
                    aria-current={crumb.path === props.directory.path ? "page" : undefined}
                  >
                    {crumb.name}
                  </ButtonLink>
                </li>
              )}
            </For>
          </ol>
        </nav>
        <ButtonLink
          navigation="enhanced"
          onNavigate={props.onNavigate}
          size="sm"
          variant="secondary"
          href={filesUrl(props.directory.base.id, props.directory.path, props.after)}
        >
          <i class="ti ti-refresh" aria-hidden="true" />
          {t().refresh}
        </ButtonLink>
      </div>
      <Show when={download.error()}>
        {(error) => (
          <InlineGuidance tone="danger" role="alert">
            {error().message}
          </InlineGuidance>
        )}
      </Show>
      <Show
        when={props.directory.items.length > 0}
        fallback={
          <div class="flex min-h-0 flex-1 items-center justify-center">
            <Placeholder variant="panel" icon="ti ti-folder" description={t().empty} />
          </div>
        }
      >
        <DataTable<FileEntry>
          rows={props.directory.items}
          columns={columns()}
          ariaLabel={t().files}
          getRowId={(row) => row.path}
          empty={<Placeholder icon="ti ti-folder" description={t().empty} />}
          renderCell={({ row, col }) => {
            if (col.id === "name")
              return row.directory ? (
                <ButtonLink
                  navigation="enhanced"
                  onNavigate={props.onNavigate}
                  variant="text"
                  size="sm"
                  wrap
                  href={filesUrl(props.directory.base.id, row.path)}
                >
                  <i class="ti ti-folder" aria-hidden="true" />
                  {row.name}
                </ButtonLink>
              ) : (
                <span class="flex items-center gap-2">
                  <i class="ti ti-file" aria-hidden="true" />
                  <span class="break-all">{row.name}</span>
                </span>
              );
            if (col.id === "size") return row.directory ? "—" : <Format.Bytes value={row.size} />;
            if (col.id === "modified") return <Format.DateTime value={row.modified} />;
            return (
              <Show when={!row.directory}>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={download.loading()}
                  onClick={() => startDownload(row.path)}
                  aria-label={`${t().download}: ${row.name}`}
                >
                  <i class="ti ti-download" aria-hidden="true" />
                  {t().download}
                </Button>
              </Show>
            );
          }}
        />
      </Show>
      <Show when={download.loading()}>
        <InlineGuidance loading>{t().preparingDownload}</InlineGuidance>
      </Show>
      <nav class="flex flex-wrap gap-2" aria-label={t().files}>
        <Show when={props.after}>
          <ButtonLink
            navigation="enhanced"
            onNavigate={props.onNavigate}
            size="sm"
            variant="secondary"
            href={filesUrl(props.directory.base.id, props.directory.path)}
          >
            {t().first}
          </ButtonLink>
        </Show>
        <Show when={props.directory.next}>
          {(next) => (
            <ButtonLink
              navigation="enhanced"
              onNavigate={props.onNavigate}
              size="sm"
              variant="secondary"
              href={filesUrl(props.directory.base.id, props.directory.path, next())}
            >
              {t().next}
              <i class="ti ti-chevron-right" aria-hidden="true" />
            </ButtonLink>
          )}
        </Show>
      </nav>
    </section>
  );
}

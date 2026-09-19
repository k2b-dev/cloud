import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { Button, ButtonLink, DataTable, Format, InlineGuidance, Placeholder, prompts } from "@k2b/ui";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../api/client";
import { type AdminBrowseResult, ErrorSchema, type FileEntry } from "../contracts";
import AdminVersions from "./AdminVersions";
import { type AdminLocation, adminHref } from "./admin-location";
import { useAdminMessages } from "./admin-messages";
import { useFilesMessages } from "./messages";
import { pathCrumbs } from "./urls";
export default function AdminBrowser(props: {
  browse: AdminBrowseResult;
  versioningEnabled?: boolean;
  location: AdminLocation;
  busy: boolean;
  onNavigate: (event: LinkNavigateEvent) => Promise<void>;
  onDelete: (entry: FileEntry) => void;
}) {
  const t = useFilesMessages();
  const a = useAdminMessages();
  const lifetime = new AbortController();
  const [versionsOpen, setVersionsOpen] = createSignal(false);
  const showVersions = async (entry: FileEntry) => {
    if (!props.versioningEnabled || versionsOpen() || props.busy) return;
    const locator = {
      area: props.browse.area,
      kind: props.browse.kind,
      name: props.browse.name,
      archiveId: props.browse.archiveId ?? undefined,
      path: entry.path,
    };
    setVersionsOpen(true);
    try {
      const fullPath = [props.browse.basePath, entry.path].filter(Boolean).join("/");
      await prompts.dialog<void>((close) => <AdminVersions locator={locator} fullPath={fullPath} name={entry.name} onClose={close} />, {
        title: a().versions,
        icon: "ti ti-history",
        size: "large",
        signal: lifetime.signal,
      });
    } finally {
      setVersionsOpen(false);
    }
  };
  const download = mutation.create({
    mutation: async (path: string, { abortSignal }) => {
      const response = await apiClient.admin.download.$post(
        {
          json: {
            area: props.browse.area,
            kind: props.browse.kind,
            name: props.browse.name,
            archiveId: props.browse.archiveId ?? undefined,
            path,
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) {
        const parsed = ErrorSchema.safeParse(await response.json());
        throw new Error(parsed.success && parsed.data.code !== "unavailable" ? parsed.data.message : a().actionFailed);
      }
      return response.json();
    },
    onSuccess: (lease) => window.location.assign(lease.url),
  });
  onCleanup(() => {
    download.abort();
    lifetime.abort();
  });
  return (
    <DataTable.Panel>
      <DataTable.Header title={props.browse.name} subtitle={props.browse.basePath} />
      <DataTable.Controls>
        <div class="flex flex-wrap items-center gap-2">
          <ButtonLink
            size="sm"
            variant="secondary"
            href={adminHref(props.location, { name: undefined, archiveId: undefined, path: "", after: undefined })}
            navigation="enhanced"
            onNavigate={props.onNavigate}
          >
            <i class="ti ti-arrow-left" aria-hidden="true" />
            {a().back}
          </ButtonLink>
          <nav aria-label={t().breadcrumbs} class="flex flex-wrap items-center gap-1">
            <ButtonLink
              size="sm"
              variant="text"
              href={adminHref(props.location, { path: "", after: undefined })}
              navigation="enhanced"
              onNavigate={props.onNavigate}
            >
              {props.browse.name}
            </ButtonLink>
            <For each={pathCrumbs(props.browse.path)}>
              {(crumb) => (
                <>
                  <span aria-hidden="true">/</span>
                  <ButtonLink
                    size="sm"
                    variant="text"
                    href={adminHref(props.location, { path: crumb.path, after: undefined })}
                    navigation="enhanced"
                    onNavigate={props.onNavigate}
                  >
                    {crumb.name}
                  </ButtonLink>
                </>
              )}
            </For>
          </nav>
          <Show when={!props.browse.archiveId && props.browse.path !== "trash"}>
            <ButtonLink
              size="sm"
              variant="ghost"
              href={adminHref(props.location, { path: "trash", after: undefined })}
              navigation="enhanced"
              onNavigate={props.onNavigate}
            >
              {a().trash}
            </ButtonLink>
          </Show>
        </div>
      </DataTable.Controls>
      <Show when={download.error()}>
        {(error) => (
          <InlineGuidance tone="danger" role="alert">
            {error().message}
          </InlineGuidance>
        )}
      </Show>
      <DataTable<FileEntry>
        surface="plain"
        density="compact"
        rows={props.browse.items}
        ariaLabel={a().inspect}
        columns={[
          { id: "name", header: t().name },
          { id: "size", header: t().size, align: "right" },
          { id: "modified", header: t().modified },
          { id: "actions", header: t().actions, align: "right" },
        ]}
        getRowId={(row) => row.path}
        empty={<Placeholder description={t().empty} />}
        renderCell={({ row, col }) => {
          if (col.id === "name")
            return row.directory ? (
              <ButtonLink
                size="sm"
                variant="text"
                href={adminHref(props.location, { path: row.path, after: undefined })}
                navigation="enhanced"
                onNavigate={props.onNavigate}
              >
                <i class="ti ti-folder" aria-hidden="true" />
                {row.name}
              </ButtonLink>
            ) : (
              row.name
            );
          if (col.id === "size") return row.directory ? "—" : <Format.Bytes value={row.size} />;
          if (col.id === "modified") return <Format.DateTime value={row.modified} />;
          return (
            <div class="flex justify-end gap-1">
              <Show when={!row.directory}>
                <Show when={props.versioningEnabled}>
                  <Button size="sm" variant="ghost" disabled={versionsOpen() || props.busy} onClick={() => void showVersions(row)}>
                    <i class="ti ti-history" aria-hidden="true" />
                    {a().versions}
                  </Button>
                </Show>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={download.loading() || props.busy}
                  onClick={() => void download.mutate(row.path)}
                >
                  {t().download}
                </Button>
              </Show>
              <Button size="sm" variant="danger" disabled={props.busy} onClick={() => props.onDelete(row)}>
                {a().delete}
              </Button>
            </div>
          );
        }}
      />
    </DataTable.Panel>
  );
}

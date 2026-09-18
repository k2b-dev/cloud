import { Button, InlineGuidance, PanelDialog, Placeholder, dialogCore, panelDialogOptions } from "@k2b/ui";
import { createResource, createSignal, For, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { BaseSummary, FileEntry } from "../contracts";
import { useBrowserMessages } from "./browser-messages";
import { apiFailure } from "./file-preview";
import { useFilesMessages } from "./messages";

export type Destination = { baseId: string; folder: string };
type Location = { baseId: string | null; folder: string };

/** Folder picker for move and copy. Storage locations are the first level of folders; another location always means a copy. */
export function openDestinationDialog(options: {
  bases: readonly BaseSummary[];
  sourceBaseId: string;
  sourcePaths: readonly string[];
  initialFolder: string;
  copyOnly?: boolean;
}): Promise<(Destination & { copy: boolean }) | null> {
  return dialogCore.open<(Destination & { copy: boolean }) | null>((close) => <DestinationPicker {...options} close={close} />, panelDialogOptions).then((value) => value ?? null);
}

function DestinationPicker(props: {
  bases: readonly BaseSummary[];
  sourceBaseId: string;
  sourcePaths: readonly string[];
  initialFolder: string;
  copyOnly?: boolean;
  close: (value: (Destination & { copy: boolean }) | null) => void;
}) {
  const b = useBrowserMessages();
  const t = useFilesMessages();
  const [location, setLocation] = createSignal<Location>({ baseId: props.sourceBaseId, folder: props.initialFolder });
  const bases = () => props.bases.filter((base) => base.status === "existing");
  const base = () => bases().find((item) => item.id === location().baseId) ?? null;
  const [folders] = createResource(
    () => location(),
    async ({ baseId, folder }) => {
      if (!baseId) return [] as FileEntry[];
      const response = await apiClient.bases[":baseId"].entries.$get({ param: { baseId }, query: { path: folder } });
      if (!response.ok) await apiFailure(response, t().unavailable);
      const page = await response.json();
      return page.items.filter((entry: FileEntry) => entry.directory && !(baseId === props.sourceBaseId && props.sourcePaths.includes(entry.path)));
    },
  );
  const copy = () => props.copyOnly || location().baseId !== props.sourceBaseId;
  const crumbs = () => location().folder.split("/").filter(Boolean);
  const invalid = () =>
    !location().baseId ||
    (location().baseId === props.sourceBaseId &&
      !copy() &&
      props.sourcePaths.some((path) => location().folder === path || location().folder.startsWith(`${path}/`) || location().folder === path.split("/").slice(0, -1).join("/")));
  const tile = (icon: string, label: string, onClick: () => void) => (
    <button type="button" class="filesv2-picker__tile" onClick={onClick}>
      <i class={icon} aria-hidden="true" />
      <span class="filesv2-picker__label" title={label}>
        {label}
      </span>
    </button>
  );
  return (
    <PanelDialog>
      <PanelDialog.Header title={b().chooseDestination} icon="ti ti-folder-symlink" close={() => props.close(null)} />
      <PanelDialog.Body>
        <InlineGuidance icon="ti ti-info-circle">{copy() ? b().otherStorageCopies : b().sameStorageMoves}</InlineGuidance>
        <nav aria-label={t().breadcrumbs} class="flex min-h-7 flex-wrap items-center gap-1 text-sm">
          <Button size="xs" variant={location().baseId ? "text" : "subtle"} onClick={() => setLocation({ baseId: null, folder: "" })}>
            <i class="ti ti-database" aria-hidden="true" />
            {t().storage}
          </Button>
          <Show when={base()}>
            {(current) => (
              <>
                <span aria-hidden="true" class="text-dimmed">
                  /
                </span>
                <Button size="xs" variant={crumbs().length ? "text" : "subtle"} onClick={() => setLocation({ baseId: current().id, folder: "" })}>
                  {current().name}
                </Button>
              </>
            )}
          </Show>
          <For each={crumbs()}>
            {(name, index) => (
              <>
                <span aria-hidden="true" class="text-dimmed">
                  /
                </span>
                <Button size="xs" variant={index() === crumbs().length - 1 ? "subtle" : "text"} onClick={() => setLocation({ baseId: location().baseId, folder: crumbs().slice(0, index() + 1).join("/") })}>
                  {name}
                </Button>
              </>
            )}
          </For>
        </nav>
        <div class="filesv2-picker" role="list" aria-label={b().chooseDestination}>
          <Show
            when={location().baseId}
            fallback={<For each={bases()}>{(item) => tile(item.kind === "users" ? "ti ti-home" : "ti ti-users", item.name, () => setLocation({ baseId: item.id, folder: "" }))}</For>}
          >
            <Show when={!folders.loading} fallback={<Placeholder state="loading" align="left" class="col-span-full" description={t().loadingFiles} />}>
              <Show when={!folders.error} fallback={<Placeholder state="error" align="left" class="col-span-full" description={b().loadFailed} />}>
                <Show when={folders()?.length} fallback={<p class="col-span-full text-xs text-dimmed">{b().subfolders}: 0</p>}>
                  <For each={folders()}>{(entry) => tile("ti ti-folder", entry.name, () => setLocation({ baseId: location().baseId, folder: entry.path }))}</For>
                </Show>
              </Show>
            </Show>
          </Show>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button variant="ghost" onClick={() => props.close(null)}>
          {b().cancel}
        </Button>
        <Button variant="primary" disabled={invalid()} onClick={() => props.close({ baseId: location().baseId!, folder: location().folder, copy: copy() })}>
          <i class={copy() ? "ti ti-copy" : "ti ti-arrow-move-right"} aria-hidden="true" />
          {copy() ? b().copyHere : b().moveHere}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

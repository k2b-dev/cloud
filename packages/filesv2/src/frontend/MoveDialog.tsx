import { Button, InlineGuidance, PanelDialog, Placeholder, dialogCore, panelDialogOptions } from "@k2b/ui";
import { createResource, createSignal, For, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { BaseSummary, FileEntry } from "../contracts";
import { useBrowserMessages } from "./browser-messages";
import { apiFailure } from "./file-preview";
import { useFilesMessages } from "./messages";

export type Destination = { baseId: string; folder: string };

/** Folder picker for move and copy. Another base always means a copy, so the button says what will happen. */
export function openDestinationDialog(options: {
  bases: readonly BaseSummary[];
  sourceBaseId: string;
  sourcePaths: readonly string[];
  initialFolder: string;
  copyOnly?: boolean;
}): Promise<(Destination & { copy: boolean }) | null> {
  return dialogCore.open<(Destination & { copy: boolean }) | null>(
    (close) => <DestinationPicker {...options} close={close} />,
    panelDialogOptions,
  ).then((value) => value ?? null);
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
  const [baseId, setBaseId] = createSignal(props.sourceBaseId);
  const [folder, setFolder] = createSignal(props.initialFolder);
  const [folders] = createResource(
    () => ({ baseId: baseId(), folder: folder() }),
    async ({ baseId, folder }) => {
      const response = await apiClient.bases[":baseId"].entries.$get({ param: { baseId }, query: { path: folder } });
      if (!response.ok) await apiFailure(response, t().unavailable);
      const page = await response.json();
      return page.items.filter((entry: FileEntry) => entry.directory && !props.sourcePaths.some((path) => baseId === props.sourceBaseId && entry.path === path));
    },
  );
  const copy = () => props.copyOnly || baseId() !== props.sourceBaseId;
  const crumbs = () => folder().split("/").filter(Boolean);
  const invalid = () =>
    baseId() === props.sourceBaseId &&
    !copy() &&
    props.sourcePaths.some((path) => folder() === path || folder().startsWith(`${path}/`) || folder() === path.split("/").slice(0, -1).join("/"));
  return (
    <PanelDialog>
      <PanelDialog.Header title={b().chooseDestination} icon="ti ti-folder-symlink" close={() => props.close(null)} />
      <PanelDialog.Body>
        <InlineGuidance icon="ti ti-info-circle">{copy() ? b().otherStorageCopies : b().sameStorageMoves}</InlineGuidance>
        <div class="flex flex-wrap gap-1" role="radiogroup" aria-label={t().storage}>
          <For each={props.bases.filter((base) => base.status === "existing")}>
            {(base) => (
              <Button
                size="xs"
                variant={base.id === baseId() ? "primary" : "secondary"}
                role="radio"
                aria-checked={base.id === baseId()}
                onClick={() => {
                  setBaseId(base.id);
                  setFolder("");
                }}
              >
                <i class={base.kind === "users" ? "ti ti-home" : "ti ti-users"} aria-hidden="true" />
                {base.name}
              </Button>
            )}
          </For>
        </div>
        <nav aria-label={t().breadcrumbs} class="flex flex-wrap items-center gap-1 text-sm">
          <Button size="xs" variant="text" onClick={() => setFolder("")}>
            {props.bases.find((base) => base.id === baseId())?.name}
          </Button>
          <For each={crumbs()}>
            {(name, index) => (
              <>
                <span aria-hidden="true" class="text-dimmed">
                  /
                </span>
                <Button size="xs" variant="text" onClick={() => setFolder(crumbs().slice(0, index() + 1).join("/"))}>
                  {name}
                </Button>
              </>
            )}
          </For>
        </nav>
        <Show when={!folders.loading} fallback={<Placeholder state="loading" align="left" description={t().loadingFiles} />}>
          <Show when={!folders.error} fallback={<Placeholder state="error" align="left" description={b().loadFailed} />}>
            <Show when={folders()?.length} fallback={<p class="text-sm text-dimmed">{b().emptyTitle}</p>}>
              <ul class="flex flex-col">
                <For each={folders()}>
                  {(entry) => (
                    <li>
                      <Button size="sm" variant="text" class="w-full justify-start" onClick={() => setFolder(entry.path)}>
                        <i class="ti ti-folder" aria-hidden="true" />
                        {entry.name}
                      </Button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </Show>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button variant="ghost" onClick={() => props.close(null)}>
          {b().cancel}
        </Button>
        <Button variant="primary" disabled={invalid()} onClick={() => props.close({ baseId: baseId(), folder: folder(), copy: copy() })}>
          <i class={copy() ? "ti ti-copy" : "ti ti-arrow-move-right"} aria-hidden="true" />
          {copy() ? b().copyHere : b().moveHere}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

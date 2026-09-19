import { Button, dialogCore, InlineGuidance, PanelDialog, Placeholder, panelDialogOptions } from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../api/client";
import { type BaseSummary, ErrorSchema, type FileEntry } from "../contracts";
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
  const [folders, setFolders] = createSignal<FileEntry[]>([]);
  const [next, setNext] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal(false);
  const [reset, setReset] = createSignal(false);
  let request: AbortController | undefined;
  const load = async (after?: string) => {
    const { baseId, folder } = location();
    request?.abort();
    const pending = new AbortController();
    request = pending;
    if (!baseId) { setFolders([]); setNext(null); return; }
    setLoading(true);
    setError(false);
    try {
      const response = await apiClient.bases[":baseId"].entries.$get({ param: { baseId }, query: { path: folder, after, type: "directories" } }, { init: { signal: pending.signal } });
      if (!response.ok) {
        const failure = ErrorSchema.safeParse(await response.clone().json());
        if (after && failure.success && failure.data.code === "cursor_invalid") {
          setFolders([]); setNext(null); setReset(true);
          await load();
          return;
        }
        await apiFailure(response, t().unavailable);
      }
      const result = await response.json();
      if (pending.signal.aborted) return;
      const items = result.items.filter((entry: FileEntry) => entry.directory && !(baseId === props.sourceBaseId && props.sourcePaths.includes(entry.path)));
      setFolders(previous => after ? [...previous, ...items] : items);
      setNext(result.next);
    } catch {
      if (!pending.signal.aborted) setError(true);
    } finally {
      if (!pending.signal.aborted) setLoading(false);
    }
  };
  createEffect(() => { location(); setFolders([]); setNext(null); void load(); });
  onCleanup(() => request?.abort());
  const copy = () => props.copyOnly || location().baseId !== props.sourceBaseId;
  const crumbs = () => location().folder.split("/").filter(Boolean);
  // Inside the source base nothing may land in its own subtree; a move additionally needs a different parent.
  const invalid = () =>
    !location().baseId ||
    (location().baseId === props.sourceBaseId &&
      props.sourcePaths.some(
        (path) => location().folder === path || location().folder.startsWith(`${path}/`) || (!copy() && location().folder === path.split("/").slice(0, -1).join("/")),
      ));
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
        <Show when={reset()}><InlineGuidance tone="info">{b().cursorReset}</InlineGuidance></Show>
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
            <Show when={!loading()} fallback={<Placeholder state="loading" align="left" class="col-span-full" description={t().loadingFiles} />}>
              <Show when={!error()} fallback={<Placeholder state="error" align="left" class="col-span-full" description={b().loadFailed} action={<Button onClick={() => void load()}>{b().retry}</Button>} />}>
                <Show when={folders()?.length} fallback={<p class="col-span-full text-xs text-dimmed">{b().subfolders}: 0</p>}>
                  <For each={folders()}>{(entry) => tile("ti ti-folder", entry.name, () => setLocation({ baseId: location().baseId, folder: entry.path }))}</For>
                </Show>
              </Show>
            </Show>
          </Show>
        </div>
        <Show when={next()}>{cursor => <Button variant="ghost" disabled={loading()} onClick={() => void load(cursor())}>{b().more}</Button>}</Show>
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

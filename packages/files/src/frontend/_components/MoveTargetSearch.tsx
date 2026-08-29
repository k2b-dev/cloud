import { mutation as mutations, timed as timing } from "@k2b/stdlib/solid";
import { Button, Placeholder, prompts, TextInput, toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { FileBaseInfo } from "@/contracts";
import { parseSelectionKey, type SelectionKey } from "./context";
import { filesMessages } from "../messages";

type MoveTargetSearchProps = {
  sourceBaseType: FileBaseInfo["type"];
  sourceBaseId: string;
  sourcePaths: string[];
  bases: FileBaseInfo[] /** For multi-base copy: all source selection keys */;
  allSourceKeys?: SelectionKey[] /** For multi-base copy: force copy mode */;
  isMultiBaseCopy?: boolean;
  onComplete: (target: { baseType: FileBaseInfo["type"]; baseId: string; path: string; movedFiles: string[] }) => void;
  close: () => void;
};
type DirectoryResult = { path: string; name: string };
type DirectorySearchResponse = { directories: DirectoryResult[]; total: number };
type TransferResponse = { moved: boolean; transferred: number; errors: { path: string; error: string }[] };
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isDirectorySearchResponse = (value: unknown): value is DirectorySearchResponse => {
  if (!isObject(value)) return false;
  return Array.isArray(value["directories"]);
};
const isTransferResponse = (value: unknown): value is TransferResponse => {
  if (!isObject(value)) return false;
  return typeof value["moved"] === "boolean" && typeof value["transferred"] === "number" && Array.isArray(value["errors"]);
};
const formatDisplayPath = (path: string, baseName: string): string => {
  if (path === "/") return `/ (${baseName})`;
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 3) return path;
  return `/${segments[0]}/.../${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
};
export default function MoveTargetSearch(props: MoveTargetSearchProps) {
  const locale = useLocale();
  const t = () => filesMessages.resolve([locale()]).t;
  const [selectedBase, setSelectedBase] = createSignal<FileBaseInfo>(
    props.bases.find((b) => b.type === props.sourceBaseType && b.id === props.sourceBaseId) ?? props.bases[0]!,
  );
  const [searchQuery, setSearchQuery] = createSignal("");
  const [directories, setDirectories] = createSignal<DirectoryResult[]>([]);
  const [transferringPath, setTransferringPath] = createSignal<string | null>(null);
  const isSameBase = createMemo(() => {
    if (props.isMultiBaseCopy) return false;
    const base = selectedBase();
    return base.type === props.sourceBaseType && base.id === props.sourceBaseId;
  });
  const action = createMemo<"copy" | "move">(() => (props.isMultiBaseCopy || !isSameBase() ? "copy" : "move"));
  const actionHereLabel = () => (action() === "copy" ? t().copyHere : t().moveHere);
  const searchMutation = mutations.create<DirectoryResult[], { query: string; base: FileBaseInfo }>({
    mutation: async ({ query, base }, ctx) => {
      const res = await apiClient[":baseType"][":baseId"].directories.$get(
        {
          param: { baseType: props.sourceBaseType, baseId: props.sourceBaseId },
          query: { query, targetBaseType: base.type, targetBaseId: base.id, limit: "20" },
        },
        { init: { signal: ctx.abortSignal } },
      );
      if (!res.ok) return [];
      const data = await res.json();
      return isDirectorySearchResponse(data) ? data.directories : [];
    },
    onSuccess: (items) => setDirectories(items),
    onError: (err) => {
      if (err.name === "AbortError") return;
      setDirectories([]);
    },
  });
  const runSearch = (query: string, base: FileBaseInfo) => {
    searchMutation.abort();
    void searchMutation.mutate({ query, base });
  };
  const { debouncedFn: debouncedSearch, cancel: cancelSearch } = timing.debounce(runSearch, 300);
  const handleSearchInput = (value: string) => {
    setSearchQuery(value);
    debouncedSearch(value, selectedBase());
  };
  const handleBaseChange = (base: FileBaseInfo) => {
    setSelectedBase(base);
    setDirectories([]);
    runSearch(searchQuery(), base);
  };
  const transferMutation = mutations.create<
    { moved: boolean; transferred: number; errors: { path: string; error: string }[]; targetPath: string },
    { targetPath: string }
  >({
    mutation: async ({ targetPath }) => {
      const base = selectedBase();
      if (props.isMultiBaseCopy && props.allSourceKeys) {
        const byBase = new Map<string, { baseType: FileBaseInfo["type"]; baseId: string; paths: string[] }>();
        for (const key of props.allSourceKeys) {
          const parsed = parseSelectionKey(key);
          if (!parsed) continue;
          const baseKey = `${parsed.baseType}:${parsed.baseId}`;
          if (!byBase.has(baseKey)) {
            byBase.set(baseKey, { baseType: parsed.baseType, baseId: parsed.baseId, paths: [] });
          }
          byBase.get(baseKey)!.paths.push(parsed.path);
        }
        let totalTransferred = 0;
        const allErrors: { path: string; error: string }[] = [];
        for (const source of byBase.values()) {
          const res = await apiClient[":baseType"][":baseId"].transfer.$post({
            param: { baseType: source.baseType, baseId: source.baseId },
            json: { paths: source.paths, targetBaseType: base.type, targetBaseId: base.id, targetPath },
          });
          if (res.ok) {
            const data = await res.json();
            if (isTransferResponse(data)) {
              totalTransferred += data.transferred;
              allErrors.push(...data.errors);
            } else {
              for (const path of source.paths) {
                allErrors.push({ path, error: t().transferFailed });
              }
            }
          } else {
            for (const path of source.paths) {
              allErrors.push({ path, error: t().transferFailed });
            }
          }
        }
        return { moved: false, transferred: totalTransferred, errors: allErrors, targetPath };
      }
      const res = await apiClient[":baseType"][":baseId"].transfer.$post({
        param: { baseType: props.sourceBaseType, baseId: props.sourceBaseId },
        json: { paths: props.sourcePaths, targetBaseType: base.type, targetBaseId: base.id, targetPath },
      });
      if (!res.ok) {
        throw new Error(t().transferFailed);
      }
      const data = await res.json();
      if (!isTransferResponse(data)) throw new Error(t().transferFailed);
      return { ...data, targetPath };
    },
    onSuccess: async (data) => {
      const base = selectedBase();
      if (data.errors.length > 0) {
        await prompts.alert(
          `${t().partialTransfer({ transferred: data.transferred, failed: data.errors.length })}\n\n${data.errors.map((e) => `${e.path}: ${t().transferFailed}`).join("\n")}`,
          { title: t().partialSuccess, icon: "ti ti-alert-triangle" },
        );
      } else if (data.transferred > 0) {
        toast.success(action() === "copy" ? t().copiedItems({ count: data.transferred }) : t().movedItems({ count: data.transferred }));
      }
      props.close();
      const movedFiles =
        props.isMultiBaseCopy && props.allSourceKeys
          ? props.allSourceKeys.map((key) => key.split("/").pop() || "")
          : props.sourcePaths.map((p) => p.split("/").pop() || "");
      props.onComplete({ baseType: base.type, baseId: base.id, path: data.targetPath, movedFiles });
    },
    onError: (err) => {
      prompts.error(err.message);
      setTransferringPath(null);
    },
  });
  const handleTransfer = async (targetPath: string) => {
    setTransferringPath(targetPath);
    await transferMutation.mutate({ targetPath });
  };
  onMount(() => runSearch("", selectedBase()));
  onCleanup(() => {
    cancelSearch();
    searchMutation.abort();
  });
  return (
    <div class="flex flex-col gap-5">
      <Show
        when={!props.isMultiBaseCopy}
        fallback={
          <div class="flex items-center gap-3 text-sm text-secondary">
            <span class="app-accent-text flex size-9 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-[var(--ui-selected)]">
              <i class="ti ti-copy" />
            </span>
            <span>{t().crossCopy}</span>
          </div>
        }
      >
        <div class="grid gap-2 text-sm text-secondary sm:grid-cols-2">
          <div class="flex items-start gap-3 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] p-3">
            <div class="app-accent-text flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-[var(--ui-selected)]">
              <i class="ti ti-arrow-move-right" />
            </div>
            <div>
              <div class="font-medium text-primary">{t().sameLocation}</div>
              <div class="text-xs text-dimmed">{t().sameLocationDescription}</div>
            </div>
          </div>
          <div class="flex items-start gap-3 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] p-3">
            <div class="app-accent-text flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-[var(--ui-selected)]">
              <i class="ti ti-copy" />
            </div>
            <div>
              <div class="font-medium text-primary">{t().differentLocation}</div>
              <div class="text-xs text-dimmed">{t().differentLocationDescription}</div>
            </div>
          </div>
        </div>
      </Show>
      <div class="flex flex-col gap-2">
        <div class="section-label mb-0">{t().destination}</div>
        <div class="flex flex-wrap gap-2">
          <For each={props.bases}>
            {(base) => {
              const isSelected = () => selectedBase().type === base.type && selectedBase().id === base.id;
              const isCurrent = base.type === props.sourceBaseType && base.id === props.sourceBaseId;
              return (
                <Button type="button" onClick={() => handleBaseChange(base)} variant={isSelected() ? "subtle" : "secondary"} size="sm">
                  <i class={`ti ${base.type === "home" ? "ti-home" : "ti-users-group"}`} /> {base.name}
                  <Show when={isCurrent}>
                    <span class="opacity-60">({t().current})</span>
                  </Show>
                </Button>
              );
            }}
          </For>
        </div>
      </div>
      <TextInput
        value={searchQuery}
        onValueChange={handleSearchInput}
        placeholder={t().searchFolders}
        icon="ti ti-search"
        activeIcon="ti ti-pencil"
        autofocus
      />
      <div class="paper overflow-hidden">
        <div class="data-table-header data-table-divider flex items-center justify-between border-b px-4 py-3 text-xs text-dimmed">
          <span>{t().folders}</span>
          <span>{t().resultsCount({ count: directories().length })}</span>
        </div>
        <div class="max-h-[22rem] overflow-y-auto">
          <Show when={searchMutation.loading()}>
            <div class="flex items-center justify-center py-10 text-dimmed">
              <i class="ti ti-loader-2 animate-spin text-xl" />
            </div>
          </Show>
          <Show when={!searchMutation.loading() && directories().length === 0}>
            <Placeholder align="left" icon="ti ti-folder-off" class="px-4" description={<>{t().noFolders}</>} />
          </Show>
          <Show when={!searchMutation.loading() && directories().length > 0}>
            <div class="flex flex-col gap-0.5 p-1">
              <For each={directories()}>
                {(dir) => (
                  <div class="flex items-center gap-4 rounded-[var(--ui-radius-control)] px-3 py-2 transition-colors hover:bg-[var(--ui-hover)]">
                    <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] text-dimmed">
                      <i class="ti ti-folder text-base" />
                    </div>
                    <div class="min-w-0 flex-1">
                      <div class="truncate text-sm text-primary">{dir.name || "/"}</div>
                      <div class="truncate text-xs text-dimmed">{formatDisplayPath(dir.path, selectedBase().name)}</div>
                    </div>
                    <Button
                      type="button"
                      onClick={() => handleTransfer(dir.path)}
                      disabled={transferringPath() !== null}
                      variant="secondary"
                      size="sm"
                    >
                      <Show
                        when={transferringPath() === dir.path}
                        fallback={
                          <>
                            {actionHereLabel()} <i class="ti ti-arrow-right" />
                          </>
                        }
                      >
                        <i class="ti ti-loader-2 animate-spin" />
                      </Show>
                    </Button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}

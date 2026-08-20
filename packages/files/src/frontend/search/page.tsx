import { AppWorkspace, ButtonLink, Placeholder, ScrollArea, TextInput } from "@k2b/ui";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { expectUserBackedActor } from "@valentinkolb/cloud/server";
import { Layout } from "@valentinkolb/cloud/ssr";
import type { FileBaseInfo, FileInfo, SearchResult } from "@/contracts";
import { filesService } from "@/service";
import { ssr } from "../../config";
import BaseSidebar from "../_components/BaseSidebar";
import FileDetailLayoutSync from "../_components/FileDetailLayoutSync.island";
import FileDetailPanel from "../_components/FileDetailPanel.island";
import FileList from "../_components/FileList.island";
import FilesUnavailable from "../_components/FilesUnavailable";
import { filePageBaseUrl } from "../url";

/** Shortcut presets for common searches */
const SEARCH_SHORTCUTS = [
  { label: "PDFs", pattern: "**/*.pdf", icon: "ti-file-type-pdf" },
  {
    label: "Images",
    pattern: "**/*.{jpg,jpeg,png,gif,webp,svg}",
    icon: "ti-photo",
  },
  { label: "Videos", pattern: "**/*.{mp4,mkv,avi,mov,webm}", icon: "ti-video" },
  {
    label: "Documents",
    pattern: "**/*.{doc,docx,odt,rtf}",
    icon: "ti-file-text",
  },
  {
    label: "Spreadsheets",
    pattern: "**/*.{xls,xlsx,ods,csv}",
    icon: "ti-table",
  },
  {
    label: "Archives",
    pattern: "**/*.{zip,tar,gz,7z,rar}",
    icon: "ti-file-zip",
  },
  {
    label: "Code",
    pattern: "**/*.{js,ts,py,go,rs,java,c,cpp,h}",
    icon: "ti-code",
  },
];

export default ssr<AuthContext>(async (c) => {
  const user = expectUserBackedActor(c);

  // Parse query params
  const pattern = c.req.query("pattern") ?? "";
  const basesParam = c.req.query("bases") ?? "";
  const showHiddenParam = c.req.query("hidden") === "true";
  const showDirsParam = c.req.query("dirs") === "true";
  const hasSearch = pattern.trim() !== "";

  // Detail panel: file query param (format: "baseType:baseId:path")
  const detailFileParam = c.req.query("file") ?? null;

  // Get all accessible bases
  const allBases = await filesService.base.listResolved({ user });
  const basesInfo: FileBaseInfo[] = allBases.map(filesService.base.toInfo);

  if (basesInfo.length === 0) {
    return () => (
      <Layout c={c} title={[{ title: "Start", href: "/" }, { title: "Files", href: "/app/files" }, { title: "Search" }]} fullWidth>
        <FilesUnavailable
          title="No accessible storage"
          description="Ask an administrator to grant access to a home or group file storage."
          icon="ti ti-folder-off"
          actionHref="/"
          actionLabel="Back to start"
        />
      </Layout>
    );
  }

  // Parse selected bases (default: all)
  const selectedBaseIds = basesParam ? new Set(basesParam.split(",").filter(Boolean)) : new Set(basesInfo.map((b) => `${b.type}:${b.id}`));

  // Filter bases to search
  const basesToSearch = allBases.filter((b) => {
    const key = b.type === "home" ? `home:${b.uid}` : `group:${b.name}`;
    return selectedBaseIds.has(key);
  });

  // Perform search if pattern provided
  let searchResults: SearchResult[] = [];
  let totalFiles = 0;
  let searchError: string | null = null;

  if (hasSearch && basesToSearch.length > 0) {
    const result = await filesService.search.list({
      bases: basesToSearch,
      pattern,
      showHidden: showHiddenParam,
      limit: 20,
    });

    if (result.ok) {
      // Filter to only files or include directories based on showDirs
      searchResults = result.data.results
        .map((r) => ({
          ...r,
          files: showDirsParam ? r.files : r.files.filter((f) => f.type === "file"),
        }))
        .filter((r) => r.files.length > 0);
      totalFiles = searchResults.reduce((sum, r) => sum + r.files.length, 0);
    } else {
      searchError = result.error;
    }
  }

  // Find selected file for detail panel
  // detailFileParam format: "baseType:baseId:path" (e.g., "home:username:/folder/file.txt")
  let detailFile: FileInfo | null = null;
  let detailBaseType: string | null = null;
  let detailBaseId: string | null = null;
  let detailFilePath: string | null = null;

  if (detailFileParam) {
    const firstColon = detailFileParam.indexOf(":");
    const secondColon = detailFileParam.indexOf(":", firstColon + 1);
    if (firstColon > 0 && secondColon > firstColon) {
      detailBaseType = detailFileParam.substring(0, firstColon);
      detailBaseId = detailFileParam.substring(firstColon + 1, secondColon);
      detailFilePath = detailFileParam.substring(secondColon + 1);

      // Find file in search results
      const matchingResult = searchResults.find((r) => r.base.type === detailBaseType && r.base.id === detailBaseId);
      if (matchingResult) {
        detailFile = matchingResult.files.find((f) => f.path === detailFilePath) ?? null;
      }
    }
  }

  // Build URL with updated params
  const buildSearchUrl = (updates: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const newPattern = updates.pattern !== undefined ? updates.pattern : pattern;
    const newBases = updates.bases !== undefined ? updates.bases : basesParam;
    const newHidden = updates.hidden !== undefined ? updates.hidden : showHiddenParam ? "true" : "";
    const newDirs = updates.dirs !== undefined ? updates.dirs : showDirsParam ? "true" : "";

    if (newPattern) params.set("pattern", newPattern);
    if (newBases) params.set("bases", newBases);
    if (newHidden === "true") params.set("hidden", "true");
    if (newDirs === "true") params.set("dirs", "true");

    const qs = params.toString();
    return `/app/files/search${qs ? `?${qs}` : ""}`;
  };

  // Toggle base selection
  const toggleBaseUrl = (base: FileBaseInfo) => {
    const key = `${base.type}:${base.id}`;
    const currentKeys = new Set(selectedBaseIds);

    if (currentKeys.has(key)) {
      currentKeys.delete(key);
    } else {
      currentKeys.add(key);
    }

    // If all selected, clear param (default is all)
    const allSelected = currentKeys.size === basesInfo.length;
    return buildSearchUrl({
      bases: allSelected ? "" : [...currentKeys].join(","),
    });
  };

  return () => (
    <Layout c={c} title={[{ title: "Start", href: "/" }, { title: "Files", href: "/app/files" }, { title: "Search" }]} fullWidth>
      <AppWorkspace>
        <BaseSidebar bases={basesInfo} currentBaseType="search" currentBaseId="" />

        <AppWorkspace.Content>
          {/* Main content */}
          <AppWorkspace.Main class="p-[var(--ui-space-shell)]">
            <ScrollArea class="flex-1" scrollPreserveKey="files-search-results">
              <div class="flex flex-col gap-2">
                {/* Search form */}
                <form action="/app/files/search" method="get" class="paper flex flex-col gap-2 p-3">
                  {/* Pattern input */}
                  <TextInput
                    type="search"
                    name="pattern"
                    value={pattern}
                    placeholder="**/*.pdf, report*, *.{jpg,png}"
                    icon="ti ti-search"
                    activeIcon="ti ti-pencil"
                    autofocus
                  />

                  {/* Options row */}
                  <div class="flex flex-wrap items-center gap-3 text-xs">
                    {/* Base selection */}
                    <details class="relative">
                      <summary class="inline-flex items-center gap-1 cursor-pointer text-secondary hover:text-primary transition-colors list-none">
                        <i class="ti ti-database" />
                        <span>
                          {selectedBaseIds.size === basesInfo.length ? "All bases" : `${selectedBaseIds.size}/${basesInfo.length} bases`}
                        </span>
                        <i class="ti ti-chevron-down text-dimmed text-[10px]" />
                      </summary>
                      <div class="dropdown-menu-surface absolute left-0 top-full z-10 mt-1 w-48 p-1">
                        {basesInfo.map((base) => {
                          const key = `${base.type}:${base.id}`;
                          const isSelected = selectedBaseIds.has(key);
                          return (
                            <a href={toggleBaseUrl(base)} class="menu-item justify-between">
                              <span class="flex items-center gap-2 truncate">
                                <i class={`ti ${base.type === "home" ? "ti-home" : "ti-users-group"} text-dimmed`} />
                                {base.type === "home" ? base.name.replace("Home (", "").replace(")", "") : base.name}
                              </span>
                              {isSelected && <i class="ti ti-check app-accent-text text-xs" />}
                            </a>
                          );
                        })}
                      </div>
                    </details>

                    <label class="flex items-center gap-1.5 cursor-pointer text-secondary">
                      <input type="checkbox" name="hidden" value="true" checked={showHiddenParam} />
                      <span>Hidden</span>
                    </label>
                    <label class="flex items-center gap-1.5 cursor-pointer text-secondary">
                      <input type="checkbox" name="dirs" value="true" checked={showDirsParam} />
                      <span>Folders</span>
                    </label>
                  </div>

                  {/* Hidden field for bases */}
                  {basesParam && <input type="hidden" name="bases" value={basesParam} />}
                </form>

                {/* Shortcuts (when no search) */}
                {!hasSearch && (
                  <div class="flex flex-wrap gap-1.5">
                    {SEARCH_SHORTCUTS.map((shortcut) => (
                      <ButtonLink href={buildSearchUrl({ pattern: shortcut.pattern })} variant="secondary" size="sm">
                        <i class={`ti ${shortcut.icon}`} />
                        {shortcut.label}
                      </ButtonLink>
                    ))}
                  </div>
                )}

                {/* Search error */}
                {searchError && (
                  <div class="flex items-center gap-2 text-xs text-red-500 dark:text-red-400">
                    <i class="ti ti-alert-triangle" />
                    <span>{searchError}</span>
                  </div>
                )}

                {/* Search results */}
                {hasSearch && !searchError && (
                  <>
                    {/* Results navigation */}
                    {searchResults.length > 0 && (
                      <div class="flex flex-wrap items-center gap-2 text-sm">
                        <span class="text-dimmed">Found in:</span>
                        {searchResults.map((result, i) => (
                          <>
                            {i > 0 && <span class="text-dimmed">,</span>}
                            <a href={`#${result.base.type}-${result.base.id}`} class="text-secondary hover:text-primary transition-colors">
                              <i class={`ti ${result.base.type === "home" ? "ti-home" : "ti-users-group"} mr-1`} />
                              {result.base.name}
                            </a>
                          </>
                        ))}
                      </div>
                    )}

                    {/* Results grouped by base */}
                    {searchResults.map((result) => (
                      <div id={`${result.base.type}-${result.base.id}`} class="flex flex-col gap-2 scroll-mt-4">
                        {/* Base header */}
                        <div class="flex items-center gap-2 text-sm">
                          <i class={`ti ${result.base.type === "home" ? "ti-home" : "ti-users-group"} text-dimmed`} />
                          <a
                            href={filePageBaseUrl(result.base.type, result.base.id)}
                            class="font-medium text-secondary hover:text-primary transition-colors"
                          >
                            {result.base.name}
                          </a>
                          <span class="text-xs text-dimmed">
                            ({result.files.length}
                            {result.hasMore ? "+" : ""})
                          </span>
                        </div>

                        {/* File list */}
                        <FileList
                          items={result.files}
                          baseType={result.base.type}
                          baseId={result.base.id}
                          currentPath=""
                          parentPath={null}
                          bases={basesInfo}
                          hideSelection
                          useItemPath
                          forceListView
                          useFullDetailKey
                          selectedFilePath={detailBaseType === result.base.type && detailBaseId === result.base.id ? detailFilePath : null}
                        />

                        {/* More results hint */}
                        {result.hasMore && (
                          <div class="flex items-center gap-2 text-xs text-dimmed px-3">
                            <i class="ti ti-dots" />
                            <span>More results available - make your search more specific</span>
                          </div>
                        )}
                      </div>
                    ))}

                    {/* No results state */}
                    {totalFiles === 0 && (
                      <Placeholder align="left" icon="ti ti-file-search" class="py-4" description={<>No files match your search</>} />
                    )}
                  </>
                )}
              </div>
            </ScrollArea>
          </AppWorkspace.Main>

          <AppWorkspace.Detail
            id="files-detail-panel"
            open={Boolean(detailFileParam)}
            width="sm"
            viewTransitionName="files-detail-panel-shell"
          >
            <FileDetailPanel
              initialFile={detailFile}
              initialFilePath={detailFileParam}
              initialBaseType={detailBaseType ?? ""}
              initialBaseId={detailBaseId ?? ""}
              items={searchResults.flatMap((r) => r.files)}
              bases={basesInfo}
              useFullDetailKey
              showEmpty={false}
            />
          </AppWorkspace.Detail>
        </AppWorkspace.Content>
        <FileDetailLayoutSync detailContainerId="files-detail-panel" />
      </AppWorkspace>
    </Layout>
  );
});

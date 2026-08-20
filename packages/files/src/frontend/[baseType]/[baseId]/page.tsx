import { AppWorkspace, Placeholder, ScrollArea } from "@k2b/ui";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { expectUserBackedActor } from "@valentinkolb/cloud/server";
import { Layout } from "@valentinkolb/cloud/ssr";
import type { Context } from "hono";
import type { DirectoryListing, FileBaseInfo, FileInfo } from "@/contracts";
import { filesService } from "@/service";
import { ssr } from "../../../config";
import BaseSidebar from "../../_components/BaseSidebar";
import FileDetailLayoutSync from "../../_components/FileDetailLayoutSync.island";
import FileDetailPanel from "../../_components/FileDetailPanel.island";
import FileList from "../../_components/FileList.island";
import FileSettings, { parseFileSettings } from "../../_components/FileSettings.island";
import FilesUnavailable from "../../_components/FilesUnavailable";
import FileToolbar from "../../_components/FileToolbar.island";
import { filePageBaseUrl, filePageUrl } from "../../url";

/**
 * Build breadcrumbs for file navigation.
 * Shows: Files / BaseName / ... / Parent / Current (if path is deep)
 */
function buildBreadcrumbs(baseType: string, baseId: string, baseName: string, path: string): { title: string; href?: string }[] {
  const crumbs: { title: string; href?: string }[] = [
    { title: "Start", href: "/" },
    { title: "Files", href: "/app/files" },
    {
      title: baseName,
      href: filePageBaseUrl(baseType, baseId),
    },
  ];

  if (path === "/" || path === "") {
    // Remove href from last crumb (current page)
    crumbs[crumbs.length - 1] = { title: baseName };
    return crumbs;
  }

  // Split path into segments
  const segments = path.split("/").filter(Boolean);

  if (segments.length <= 2) {
    // Show all segments
    let currentPath = "";
    for (let i = 0; i < segments.length; i++) {
      currentPath += "/" + segments[i];
      const isLast = i === segments.length - 1;
      crumbs.push({
        title: segments[i]!,
        href: isLast ? undefined : filePageUrl(baseType, baseId, currentPath),
      });
    }
  } else {
    // Too deep - show: ... / parent / current
    crumbs.push({ title: "...", href: undefined });

    // Parent folder
    const parentSegments = segments.slice(0, -1);
    const parentPath = "/" + parentSegments.join("/");
    crumbs.push({
      title: segments[segments.length - 2]!,
      href: filePageUrl(baseType, baseId, parentPath),
    });

    // Current folder
    crumbs.push({ title: segments[segments.length - 1]! });
  }

  return crumbs;
}

/**
 * Format file size for display
 */
function formatSize(bytes: number): string {
  if (bytes === 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export const renderFilesBasePage = async <E extends AuthContext>(
  c: Context<E>,
  config?: {
    baseType?: "home" | "group";
    baseId?: string;
    path?: string;
  },
) => {
  const user = expectUserBackedActor(c);
  const baseType = config?.baseType ?? (c.req.param("baseType") as "home" | "group");
  const baseId = config?.baseId ?? c.req.param("baseId")!;
  const path = config?.path ?? c.req.query("path") ?? "/";
  const isLegacyBaseRoute = !config;
  const filterQuery = c.req.query("filter");
  const selectedParam = c.req.query("selected") ?? "";
  // Selection keys use | as separator (paths can contain commas)
  const initialSelected = selectedParam ? selectedParam.split("|").filter(Boolean) : [];

  // Detail panel: file query param
  const detailFilePath = c.req.query("file") ?? null;

  // Parse file settings from cookie
  const fileSettings = parseFileSettings(c.req.header("cookie"));
  const showHidden = fileSettings.showHidden;

  // Validate base type
  if (baseType !== "home" && baseType !== "group") {
    return c.redirect("/app/files", 302);
  }

  // Canonicalize old home route with uid segment to /app/files/home[/...]
  if (isLegacyBaseRoute && baseType === "home" && baseId === user.uid) {
    return c.redirect(filePageUrl("home", user.uid, path), 302);
  }

  // Parse base and check access
  const baseResult = await filesService.base.get({ baseType, baseId });
  if (!baseResult.ok) {
    return () => (
      <Layout c={c} title={[{ title: "Start", href: "/" }, { title: "Files" }, { title: "Not Found" }]} fullWidth>
        <FilesUnavailable title="File storage not found" description={baseResult.error} icon="ti ti-folder-off" />
      </Layout>
    );
  }

  const base = baseResult.data;
  const accessResult = await filesService.base.permission.canAccess({
    user,
    base,
  });
  if (!accessResult.ok) {
    return () => (
      <Layout c={c} title={[{ title: "Start", href: "/" }, { title: "Files" }, { title: "Access Denied" }]} fullWidth>
        <FilesUnavailable title="File storage unavailable" description={accessResult.error} icon="ti ti-lock" />
      </Layout>
    );
  }

  // Get all accessible bases for sidebar
  const allBases = await filesService.base.listResolved({ user });
  const basesInfo: FileBaseInfo[] = allBases.map(filesService.base.toInfo);

  // Get current base display name
  const currentBaseInfo = filesService.base.toInfo(base);

  // Get directory listing (with optional recursive size computation)
  const infoResult = await filesService.item.get({
    base,
    path,
    showHidden,
    computeSizes: fileSettings.computeSizes,
  });

  if (!infoResult.ok) {
    return () => (
      <Layout c={c} title={buildBreadcrumbs(baseType, baseId, currentBaseInfo.name, path)} fullWidth>
        <AppWorkspace>
          <BaseSidebar
            bases={basesInfo}
            currentBaseType={baseType}
            currentBaseId={baseId}
            settingsPanel={() => <FileSettings initialSettings={fileSettings} />}
          />
          <AppWorkspace.Content>
            <AppWorkspace.Main>
              <Placeholder
                state="error"
                variant="panel"
                title="Folder unavailable"
                description={infoResult.error}
                icon="ti ti-folder-off"
                class="h-full"
              />
            </AppWorkspace.Main>
          </AppWorkspace.Content>
        </AppWorkspace>
      </Layout>
    );
  }

  const info = infoResult.data;

  // Must be a directory
  if (info.type !== "directory") {
    // If it's a file, redirect to download
    return c.redirect(`/api/files/${baseType}/${baseId}/content?path=${encodeURIComponent(path)}`, 302);
  }

  const listing = info as DirectoryListing;

  // Filter by filter query if provided
  let filteredItems = listing.items;
  if (filterQuery && filterQuery.trim()) {
    const query = filterQuery.toLowerCase().trim();
    filteredItems = listing.items.filter((item) => item.name.toLowerCase().includes(query));
  }

  // Sort: directories first, then files, both alphabetically
  const sortedItems = [...filteredItems].sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name);
  });

  // Find selected file for detail panel
  // detailFilePath is the full path from URL (e.g., "/folder/file.txt")
  // We need to check if the file is in the current directory
  let detailFile: FileInfo | null = null;
  if (detailFilePath) {
    const detailFileName = detailFilePath.split("/").pop() || "";
    const lastSlashIndex = detailFilePath.lastIndexOf("/");
    // For "/test.txt", parent is "/"; for "/folder/test.txt", parent is "/folder"
    const detailParentPath = lastSlashIndex <= 0 ? "/" : detailFilePath.substring(0, lastSlashIndex);

    // Only show detail if file is in current directory
    const normalizedPath = path === "" ? "/" : path;
    if (detailParentPath === normalizedPath) {
      detailFile = sortedItems.find((item) => item.name === detailFileName) ?? null;
    }
  }

  // Use directory's size (filegate returns recursive total for directories)
  const totalSize = listing.size;
  const fileCount = sortedItems.filter((i) => i.type === "file").length;
  const folderCount = sortedItems.filter((i) => i.type === "directory").length;

  // Parent path for ".." entry (not shown when filtering)
  const pathSegments = path.split("/").filter(Boolean);
  const parentPath = pathSegments.length > 0 ? "/" + pathSegments.slice(0, -1).join("/") : null;

  const breadcrumbs = buildBreadcrumbs(baseType, baseId, currentBaseInfo.name, path);
  const listScrollKey = `files-list-${baseType}-${encodeURIComponent(baseId)}-${encodeURIComponent(path || "/")}`;

  return () => (
    <Layout c={c} title={breadcrumbs} fullWidth>
      <AppWorkspace>
        <BaseSidebar
          bases={basesInfo}
          currentBaseType={baseType}
          currentBaseId={baseId}
          settingsPanel={() => <FileSettings initialSettings={fileSettings} />}
        />

        <AppWorkspace.Content>
          {/* Main content */}
          <AppWorkspace.Main class="gap-2 p-[var(--ui-space-shell)]">
            <FileToolbar
              baseType={baseType}
              baseId={baseId}
              currentPath={path}
              initialFilterQuery={filterQuery ?? ""}
              initialSelected={initialSelected}
              allItems={sortedItems.map((i) => i.name)}
              folderCount={folderCount}
              fileCount={fileCount}
              totalSize={formatSize(totalSize)}
              bases={basesInfo}
            />

            {/* File list */}
            <ScrollArea class="flex-1" scrollPreserveKey={listScrollKey}>
              <FileList
                items={sortedItems}
                baseType={baseType}
                baseId={baseId}
                currentPath={path}
                parentPath={parentPath}
                settings={fileSettings}
                initialSelected={initialSelected}
                bases={basesInfo}
                isFiltered={!!filterQuery?.trim()}
                selectedFilePath={detailFilePath}
              />
            </ScrollArea>
          </AppWorkspace.Main>

          <AppWorkspace.Detail
            id="files-detail-panel"
            open={Boolean(detailFilePath)}
            width="sm"
            viewTransitionName="files-detail-panel-shell"
          >
            <FileDetailPanel
              initialFile={detailFile}
              initialFilePath={detailFilePath}
              initialBaseType={baseType}
              initialBaseId={baseId}
              items={sortedItems}
              bases={basesInfo}
              showEmpty={false}
            />
          </AppWorkspace.Detail>
        </AppWorkspace.Content>
        <FileDetailLayoutSync detailContainerId="files-detail-panel" />
      </AppWorkspace>
    </Layout>
  );
};

export default ssr<AuthContext>(async (c) => {
  return renderFilesBasePage(c);
});

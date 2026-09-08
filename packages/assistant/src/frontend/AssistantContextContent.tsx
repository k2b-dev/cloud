import { downloadFileFromContent } from "@k2b/stdlib/browser";
import {
  DetailPanel,
  type DropdownItem,
  FileBrowserPanel,
  type FileSource,
  type FileTreeEntry,
  type FileViewContent,
  MarkdownView,
  prompts,
} from "@k2b/ui";
import type { AiProjectFile } from "@valentinkolb/cloud/ai";
import {
  type CapabilityCatalogClientResult,
  type CapabilityClientResult,
  invokeCapability,
  listCapabilityCatalog,
} from "@valentinkolb/cloud/capabilities";
import { type CloudResourceRef, cloudResourceRefAppId, resolveCapabilityResourceReader } from "@valentinkolb/cloud/contracts";
import { For, type JSX, Show } from "solid-js";
import { assistantBrowserCopy, assistantBrowserText, useAssistantText } from "./ui-copy";

export type AssistantContextScope = "chat" | "project";

export type AssistantContextFile = {
  id: string;
  path: string;
  mediaType: string;
  size: number;
  scope: AssistantContextScope;
  source: FileSource;
};

export const isAssistantContextImage = (file: AssistantContextFile): boolean => file.mediaType.startsWith("image/");

export const assistantContextCountTitle = (count: number, singular: string, plural: string): string =>
  count > 0 ? `${count} ${count === 1 ? singular : plural}` : plural;

export function AssistantContextSection(props: { title: string; identity?: boolean; action?: JSX.Element; children: JSX.Element }) {
  return (
    <section class="flex flex-col gap-2">
      <div class="flex min-h-7 items-center justify-between gap-2">
        <h2
          class={
            props.identity
              ? "min-w-0 flex-1 text-sm font-semibold text-[var(--ui-app-accent-text)]"
              : "min-w-0 flex-1 text-xs font-medium text-secondary"
          }
        >
          {props.title}
        </h2>
        {props.action}
      </div>
      {props.children}
    </section>
  );
}

export function AssistantContextRow(props: {
  icon?: string;
  title: string;
  description?: string;
  scope?: AssistantContextScope;
  showScope?: boolean;
  onClick?: () => void;
  menuItems?: readonly DropdownItem[];
  menuLabel?: string;
  trailing?: JSX.Element;
}) {
  const text = useAssistantText();
  const leading = () => (props.icon ? <i class={props.icon} style={{ width: "1rem", height: "1rem", "font-size": "1rem", "line-height": "1rem", "flex-shrink": 0 }} aria-hidden="true" /> : undefined);
  const trailing = () => (
    <>
      <Show when={props.showScope && props.scope === "project"}>
        <span class="shrink-0 rounded-full bg-[var(--ui-surface)] px-1.5 py-0.5 text-[0.625rem] text-dimmed">{text("Project")}</span>
      </Show>
      {props.trailing}
    </>
  );
  return props.onClick && props.menuItems?.length ? (
    <DetailPanel.Action
      title={props.title}
      description={props.description}
      leading={leading()}
      trailing={trailing()}
      onClick={props.onClick}
      menuItems={props.menuItems}
      menuLabel={props.menuLabel ?? `${text("Actions for")} ${props.title}`}
    />
  ) : props.onClick ? (
    <DetailPanel.Action
      title={props.title}
      description={props.description}
      leading={leading()}
      trailing={trailing()}
      onClick={props.onClick}
    />
  ) : (
    <div class="k2b-detail-panel__action min-w-0">
      <span class="k2b-button__label">
        <Show when={leading()}>{(value) => <span class="k2b-detail-panel__action-leading">{value()}</span>}</Show>
        <span class="k2b-detail-panel__action-copy">
          <span class="k2b-detail-panel__action-title">{props.title}</span>
          <Show when={props.description}>
            <span class="k2b-detail-panel__action-description">{props.description}</span>
          </Show>
        </span>
        <span class="k2b-detail-panel__action-trailing">{trailing()}</span>
      </span>
    </div>
  );
}

const normalizedMarkdownTitle = (value: string) => value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();

export const assistantMarkdownBody = (title: string, markdown: string): string => {
  const lines = markdown.split(/\r?\n/u);
  const headingIndex = lines.findIndex((line) => line.trim().length > 0);
  if (headingIndex < 0) return markdown;
  const heading = lines[headingIndex]?.match(/^\s*#\s+(.+?)\s*$/u);
  if (!heading) return markdown;
  const headingTitle = heading[1]?.replace(/\s+#+\s*$/u, "") ?? "";
  if (normalizedMarkdownTitle(headingTitle) !== normalizedMarkdownTitle(title)) return markdown;
  return lines
    .slice(headingIndex + 1)
    .join("\n")
    .replace(/^(?:\s*\n)+/u, "");
};

export const openAssistantMarkdown = (title: string, markdown: string, icon = "ti ti-file-description") =>
  prompts.dialog<void>(
    () => (
      <div class="max-h-[70vh] overflow-auto">
        <MarkdownView markdown={assistantMarkdownBody(title, markdown)} headingScale="compact" />
      </div>
    ),
    { title, icon, size: "large" },
  );

export const openAssistantKnowledgeSearch = async (items: readonly { id: string; title: string; content: string }[]) => {
  const text = assistantBrowserText;
  const selected = await prompts.search<{ title: string; content: string }>(
    ({ query }) => {
      const normalized = query.trim().toLocaleLowerCase();
      return items
        .filter(
          (item) =>
            !normalized || item.title.toLocaleLowerCase().includes(normalized) || item.content.toLocaleLowerCase().includes(normalized),
        )
        .map((item) => ({ value: { title: item.title, content: item.content }, label: item.title, icon: "ti ti-bulb" }));
    },
    {
      title: text("Project knowledge"),
      icon: "ti ti-bulb",
      placeholder: text("Search Project knowledge…"),
      minQueryLength: 0,
      noResultsText: text("No matching knowledge."),
      size: "small",
    },
  );
  if (selected?.value) await openAssistantMarkdown(selected.value.title, selected.value.content, "ti ti-bulb");
};

export const confirmOpenAssistantLink = async (title: string, href: string) => {
  const text = assistantBrowserText;
  let destination: URL;
  try {
    destination = new URL(href, window.location.href);
  } catch {
    return;
  }
  const confirmed = await prompts.confirm(assistantBrowserCopy().openExternalLink({ title, host: destination.host || "Cloud" }), {
    title: text("Open link"),
    confirmText: text("Open in new tab"),
  });
  if (confirmed) window.open(destination.href, "_blank", "noopener,noreferrer");
};

export type ResolvedAssistantCloudResource = {
  ref: CloudResourceRef;
  title: string;
  icon: string;
  href?: string;
};

type AssistantCloudResourceDependencies = {
  listCatalog(input: { cursor?: string; limit?: number }): Promise<CapabilityCatalogClientResult>;
  invoke(input: { appId: string; capabilityId: string; kind: "query"; input: { id: string } }): Promise<CapabilityClientResult<unknown>>;
};

const assistantCloudResourceDependencies: AssistantCloudResourceDependencies = {
  listCatalog: listCapabilityCatalog,
  invoke: invokeCapability,
};

export const resolveAssistantCloudResource = async (
  ref: CloudResourceRef,
  dependencies: AssistantCloudResourceDependencies = assistantCloudResourceDependencies,
): Promise<ResolvedAssistantCloudResource> => {
  const appId = cloudResourceRefAppId(ref);
  let cursor: string | undefined;
  do {
    const catalog = await dependencies.listCatalog({ cursor, limit: 25 });
    if (!catalog.ok) throw new Error(catalog.error.message);
    const app = catalog.data.apps.find((candidate) => candidate.appId === appId);
    if (app) {
      const reader = resolveCapabilityResourceReader(app.manifest, ref);
      if (!reader) throw new Error(assistantBrowserText("This Cloud resource has no reader."));
      const result = await dependencies.invoke({ appId, capabilityId: reader.localId, kind: "query", input: { id: ref.id } });
      if (!result.ok) throw new Error(result.error.message);
      const localType = ref.type.slice(appId.length + 1);
      const resourceType = app.manifest.types.find((candidate) => candidate.localId === localType);
      return {
        ref,
        title: resourceType?.title ?? app.appName,
        icon: resourceType?.icon ?? app.appIcon,
        href: result.data.links?.find((link) => link.rel === "open")?.href,
      };
    }
    cursor = catalog.data.page.hasMore ? catalog.data.page.nextCursor : undefined;
  } while (cursor);
  throw new Error(assistantBrowserText("The application for this reference is unavailable."));
};

export const openAssistantCloudReference = async (title: string, ref: CloudResourceRef) => {
  try {
    const resource = await resolveAssistantCloudResource(ref);
    return resource.href
      ? confirmOpenAssistantLink(title, resource.href)
      : void prompts.error(assistantBrowserText("This Cloud resource has no open link."), { title: assistantBrowserText("Could not open reference") });
  } catch (error) {
    return void prompts.error(error instanceof Error ? error.message : assistantBrowserText("The Cloud resource could not be resolved."), {
      title: assistantBrowserText("Could not open reference"),
    });
  }
};

const virtualPath = (file: AssistantContextFile): string =>
  `/${assistantBrowserText(file.scope === "project" ? "Project" : "Chat")}/${file.path.replace(/^\/+/, "")}`;

export const assistantContextFileSource = (files: readonly AssistantContextFile[]): FileSource => ({
  async list(): Promise<FileTreeEntry[]> {
    return files.map((file) => ({
      path: virtualPath(file),
      mediaType: file.mediaType,
      size: file.size,
      badge: file.scope,
    }));
  },
  async read(path: string): Promise<FileViewContent> {
    const file = files.find((candidate) => virtualPath(candidate) === path);
    if (!file) throw new Error(assistantBrowserText("File is no longer available."));
    return file.source.read(file.path);
  },
  downloadHref(path) {
    const file = files.find((candidate) => virtualPath(candidate) === path);
    return file ? (file.source.downloadHref?.(file.path) ?? null) : null;
  },
  isReadOnly: () => true,
});

export const assistantProjectFileSource = (projectId: string, files: () => readonly AiProjectFile[]): FileSource => ({
  async list() {
    return files().map((file) => ({ path: file.path, mediaType: file.mediaType, size: file.size, updatedAt: file.updatedAt }));
  },
  async read(path) {
    const file = files().find((candidate) => candidate.path === path);
    if (!file) throw new Error(assistantBrowserText("Project file is no longer available."));
    const response = await fetch(`/api/ai/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(file.id)}`);
    if (!response.ok) throw new Error(assistantBrowserText("Project file could not be loaded."));
    const payload = (await response.json()) as { content: string; encoding: "base64"; file: { mediaType: string } };
    return { content: payload.content, encoding: payload.encoding, mediaType: payload.file.mediaType };
  },
  isReadOnly: () => true,
});

export const downloadAssistantContextFile = async (file: AssistantContextFile): Promise<void> => {
  const name = file.path.replace(/^.*\//u, "") || "download";
  const href = file.source.downloadHref?.(file.path);
  if (href) {
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = name;
    anchor.click();
    return;
  }
  const content = await file.source.read(file.path);
  const bytes =
    content.encoding === "utf8"
      ? new TextEncoder().encode(content.content)
      : Uint8Array.from(atob(content.content), (character) => character.charCodeAt(0));
  downloadFileFromContent(bytes, name, content.mediaType || file.mediaType || "application/octet-stream");
};

export const openAssistantContextFiles = (files: readonly AssistantContextFile[], selected?: AssistantContextFile) =>
  prompts.dialog<void>(
    () => (
      <div class="dialog-fixed-frame min-h-0 overflow-hidden">
        <FileBrowserPanel
          source={assistantContextFileSource(files)}
          readOnly
          initialPath={selected ? virtualPath(selected) : undefined}
          class="h-full min-h-0"
        />
      </div>
    ),
    { title: assistantBrowserText("Files"), icon: "ti ti-files", size: "wide" },
  );

export const loadAssistantContextImages = async (files: readonly AssistantContextFile[]) =>
  Promise.all(
    files.filter(isAssistantContextImage).map(async (file) => {
      const content = await file.source.read(file.path);
      const src =
        content.encoding === "base64"
          ? `data:${content.mediaType};base64,${content.content}`
          : `data:${content.mediaType};charset=utf-8,${encodeURIComponent(content.content)}`;
      return { file, image: { src, alt: file.path.replace(/^.*\//u, ""), downloadUrl: file.source.downloadHref?.(file.path) ?? src } };
    }),
  );

export function AssistantContextRows(props: { children: JSX.Element }) {
  return <div class="flex flex-col gap-1">{props.children}</div>;
}

export function AssistantContextViewAll(props: { onClick: () => void }) {
  const text = useAssistantText();
  return <AssistantContextRow icon="ti ti-eye" title={text("View all")} onClick={props.onClick} />;
}

export function AssistantContextEmpty(props: { children: JSX.Element }) {
  return <p class="text-xs text-dimmed">{props.children}</p>;
}

export function AssistantKnowledgeRows(props: {
  items: readonly { id: string; title: string; content: string }[];
  limit?: number;
  trailing?: (item: { id: string; title: string; content: string }) => JSX.Element;
}) {
  return (
    <AssistantContextRows>
      <For each={props.items.slice(0, props.limit ?? 3)}>
        {(item) => (
          <AssistantContextRow
            icon="ti ti-bulb"
            title={item.title}
            onClick={() => void openAssistantMarkdown(item.title, item.content, "ti ti-bulb")}
            trailing={props.trailing?.(item)}
          />
        )}
      </For>
    </AssistantContextRows>
  );
}

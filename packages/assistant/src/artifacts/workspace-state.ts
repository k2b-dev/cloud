import type { AiProject } from "@k2b/cloud/ai";
import type { JSX } from "solid-js";
import type { ContextCategory } from "../frontend/AssistantChatContext";
import { isWebAddress } from "../web-address";
export type WorkspaceTab =
  | { key: string; kind: "task"; taskId: string; title: string }
  | { key: string; kind: "context"; conversationId: string; category: ContextCategory; title: string; project?: AiProject | null }
  | { key: string; kind: "view"; title: string; render: () => JSX.Element }
  | { key: string; kind: "file"; conversationId: string; path: string; title: string }
  | { key: string; kind: "app"; artifactId: string; title: string; autoStart?: boolean }
  | { key: string; kind: "source"; artifactId: string; path: string; title: string }
  | { key: string; kind: "web"; conversationId: string; url: string; title: string }
  | { key: string; kind: "presentation"; conversationId: string; presentationId: string; title: string };

export function contextTab(conversationId: string, category: ContextCategory, title: string, project?: AiProject | null): WorkspaceTab {
  return { key: JSON.stringify(["context", conversationId, category]), kind: "context", conversationId, category, title, project };
}
export function taskTab(taskId: string, title: string): WorkspaceTab {
  return { key: JSON.stringify(["task", taskId]), kind: "task", taskId, title };
}
export type WorkspaceState = { tabs: WorkspaceTab[]; active: string | null };
export function fileTab(conversationId: string, path: string): WorkspaceTab {
  return { key: JSON.stringify(["file", conversationId, path]), kind: "file", conversationId, path, title: path.split("/").pop() || path };
}
export function appTab(artifactId: string, title: string, autoStart = false): WorkspaceTab {
  return { key: JSON.stringify(["app", artifactId]), kind: "app", artifactId, title, autoStart };
}
/** A visualization the assistant delivered in this chat, as the chat shows it. */
export function presentationTab(conversationId: string, presentationId: string, title: string): WorkspaceTab {
  return {
    key: JSON.stringify(["presentation", conversationId, presentationId]),
    kind: "presentation",
    conversationId,
    presentationId,
    title,
  };
}
/** A web page from this chat in the reading view. */
export function webTab(conversationId: string, url: string, title?: string): WorkspaceTab | null {
  if (!isWebAddress(url)) return null;
  const host = new URL(url).host;
  return { key: JSON.stringify(["web", conversationId, url]), kind: "web", conversationId, url, title: title || host };
}
export function sourceTab(artifactId: string, path: string): WorkspaceTab {
  return { key: JSON.stringify(["source", artifactId, path]), kind: "source", artifactId, path, title: path.split("/").pop() || path };
}
export function openWorkspaceTab(state: WorkspaceState, tab: WorkspaceTab): WorkspaceState {
  const exists = state.tabs.some((current) => current.key === tab.key);
  return {
    tabs: exists
      ? state.tabs.map((current) =>
          current.key === tab.key
            ? {
                ...current,
                title: tab.title,
                ...(current.kind === "app" && tab.kind === "app" && tab.autoStart ? { autoStart: true } : {}),
              }
            : current,
        )
      : [...state.tabs, tab],
    active: tab.key,
  };
}
export function closeWorkspaceTab(state: WorkspaceState, key: string): WorkspaceState {
  const index = state.tabs.findIndex((tab) => tab.key === key);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.key !== key);
  return { tabs, active: state.active === key ? (tabs[Math.min(index, tabs.length - 1)]?.key ?? null) : state.active };
}

export function workspaceSelectionHref(href: string, tab: WorkspaceTab | null) {
  const url = new URL(href, "http://workspace.invalid");
  url.searchParams.delete("workspace");
  if (tab && tab.kind !== "view") url.searchParams.set("workspace", tab.key);
  return `${url.pathname}${url.search}${url.hash}`;
}
export function workspaceSelectionFromHref(href: string): WorkspaceTab | null {
  try {
    const value: unknown = JSON.parse(new URL(href, "http://workspace.invalid").searchParams.get("workspace") ?? "null");
    if (!Array.isArray(value) || value.length < 2 || !value.every((part) => typeof part === "string")) return null;
    const [kind, id, path] = value;
    if (typeof id !== "string" || !id || id.length > 80) return null;
    if (kind === "task" && value.length === 2) return taskTab(id, id);
    if (kind === "app" && value.length === 2) return appTab(id, id);
    if (typeof path !== "string" || !path || path.length > 500 || value.length !== 3) return null;
    if (
      kind === "context" &&
      (path === "apps" || path === "files" || path === "sources" || path === "knowledge" || path === "tasks" || path === "context")
    )
      return contextTab(id, path, path);
    if (kind === "file") return fileTab(id, path);
    if (kind === "source") return sourceTab(id, path);
    if (kind === "web") return webTab(id, path);
    if (kind === "presentation" && /^[0-9a-f-]{36}$/u.test(path)) return presentationTab(id, path, "");
  } catch {
    /* Invalid URL state is ignored; resource APIs still authorize every read. */
  }
  return null;
}

/** A Panes item id for a tab: a letter, then letters, digits, `_` or `-`; stable for the tab's key. */
export function workspaceTabId(key: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `t${(hash >>> 0).toString(36)}-${key.length.toString(36)}`;
}

/** A tab from its stored key, or null for a key this version cannot open again. */
export function workspaceTabFromKey(key: string, title: string): WorkspaceTab | null {
  const tab = workspaceSelectionFromHref(`/?workspace=${encodeURIComponent(key)}`);
  return tab ? { ...tab, title: tab.kind === "context" ? tab.title : title || tab.title } : null;
}

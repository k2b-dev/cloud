import { installDesktopBridge, type DesktopBridge } from "@k2b/cloud/desktop";
import type { BridgeResult, DesktopLabBridge } from "../bridge/types";

const post = async <T>(path: string, body?: unknown): Promise<BridgeResult<T>> => {
  const res = await fetch(`/bridge/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

  const data = (await res.json().catch(() => null)) as BridgeResult<T> | null;
  if (!data) return { ok: false, error: `Bridge returned invalid JSON (${res.status})` };
  return data;
};

const createHttpBridge = (): DesktopLabBridge => ({
  getState: () => post("state"),
  getDesktopEnvironment: () => post("desktop-environment"),
  getMarkdownWorkspace: () => post("markdown-workspace"),
  addMarkdownFolder: () => post("markdown-folder-add"),
  removeMarkdownFolder: (input) => post("markdown-folder-remove", input),
  rescanMarkdownFolders: () => post("markdown-rescan"),
  readMarkdownFile: (input) => post("markdown-file-read", input),
  saveMarkdownFile: (input) => post("markdown-file-save", input),
  createMarkdownFile: (input) => post("markdown-file-create", input),
  renameMarkdownFile: (input) => post("markdown-file-rename", input),
  deleteMarkdownFile: (input) => post("markdown-file-delete", input),
  setMode: (input) => post("mode", input),
  saveLocalNote: (input) => post("local-note", input),
  connectCloud: (input) => post("connect-cloud", input),
  disconnectCloud: () => post("disconnect-cloud"),
  syncNow: () => post("sync-now"),
  openNativeFileDialog: () => post("native-open-file"),
  showNativeMessage: (input) => post("native-message", input),
  showNativeNotification: () => post("native-notification"),
  writeNativeClipboard: (input) => post("native-clipboard-write", input),
  readNativeClipboard: () => post("native-clipboard-read"),
  showNativeContextMenu: () => post("native-context-menu"),
  showNativeTextPrompt: async (input) => ({
    ok: true,
    data: {
      label: "Browser prompt",
      detail: "Browser prompt opened by the development harness.",
      value: window.prompt(input.message, input.defaultValue ?? "") ?? undefined,
    },
  }),
  openNativeExternal: (input) => post("native-open-external", input),
  getNativeWindowDescriptor: (input) => post("native-window-descriptor", input),
  openNativeWindow: (input) => post("native-window-open", input),
  closeNativeWindow: (input) => post("native-window-close", input),
  minimizeNativeWindow: (input) => post("native-window-minimize", input),
  maximizeNativeWindow: (input) => post("native-window-maximize", input),
  focusNativeWindow: (input) => post("native-window-focus", input),
  setNativeWindowTitle: (input) => post("native-window-title", input),
});

const createHttpRuntimeBridge = (): DesktopBridge => ({
  getEnvironment: () => post("desktop-environment"),
  openFileDialog: async () => {
    const result = await post<{ paths?: string[] }>("native-open-file");
    if (!result.ok) return result;
    return { ok: true, data: { paths: result.data.paths ?? [] } };
  },
  showMessage: async (input) => {
    const result = await post("native-message", input);
    if (!result.ok) return result;
    return { ok: true, data: {} };
  },
  showNotification: async (input) => {
    const result = await post("native-notification", input);
    if (!result.ok) return result;
    return { ok: true, data: undefined };
  },
  clipboardWriteText: async (value) => {
    const result = await post("native-clipboard-write", { value });
    if (!result.ok) return result;
    return { ok: true, data: undefined };
  },
  clipboardReadText: async () => {
    const result = await post<{ value?: string }>("native-clipboard-read");
    if (!result.ok) return result;
    return { ok: true, data: result.data.value ?? "" };
  },
  showContextMenu: async (items) => {
    const result = await post("native-context-menu", { items });
    if (!result.ok) return result;
    return { ok: true, data: undefined };
  },
  openExternal: async (url) => {
    const result = await post("native-open-external", { url });
    if (!result.ok) return result;
    return { ok: true, data: true };
  },
  closeWindow: async () => {
    const result = await post("native-window-close");
    if (!result.ok) return result;
    return { ok: true, data: undefined };
  },
  minimizeWindow: async () => {
    const result = await post("native-window-minimize");
    if (!result.ok) return result;
    return { ok: true, data: undefined };
  },
  maximizeWindow: async () => {
    const result = await post("native-window-maximize");
    if (!result.ok) return result;
    return { ok: true, data: undefined };
  },
  getCurrentWindowDescriptor: async () => ({ ok: true, data: null }),
});

export const getDesktopBridge = (): DesktopLabBridge => {
  const bridge = window.cloudDesktop ?? createHttpBridge();
  if (!window.cloudDesktopRuntime) installDesktopBridge(createHttpRuntimeBridge());
  return bridge;
};

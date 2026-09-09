import { Electroview } from "electrobun/view";
import { installDesktopBridge, type DesktopBridge } from "@k2b/cloud/desktop";
import type { DesktopLabBridge } from "../../bridge/types";
import type { DesktopLabRPC } from "./rpc";

const rpc = Electroview.defineRPC<DesktopLabRPC>({
  maxRequestTime: Infinity,
  handlers: {
    requests: {},
    messages: {},
  },
});

new Electroview({ rpc });

const currentWindowInput = () => ({ id: String((window as unknown as { __electrobunWindowId?: number }).__electrobunWindowId ?? "") });

const bridge: DesktopLabBridge = {
  getState: () => rpc.request.getState(),
  getDesktopEnvironment: () => rpc.request.getDesktopEnvironment(),
  getMarkdownWorkspace: () => rpc.request.getMarkdownWorkspace(),
  addMarkdownFolder: () => rpc.request.addMarkdownFolder(),
  removeMarkdownFolder: (input) => rpc.request.removeMarkdownFolder(input),
  rescanMarkdownFolders: () => rpc.request.rescanMarkdownFolders(),
  readMarkdownFile: (input) => rpc.request.readMarkdownFile(input),
  saveMarkdownFile: (input) => rpc.request.saveMarkdownFile(input),
  createMarkdownFile: (input) => rpc.request.createMarkdownFile(input),
  renameMarkdownFile: (input) => rpc.request.renameMarkdownFile(input),
  deleteMarkdownFile: (input) => rpc.request.deleteMarkdownFile(input),
  setMode: (input) => rpc.request.setMode(input),
  saveLocalNote: (input) => rpc.request.saveLocalNote(input),
  connectCloud: (input) => rpc.request.connectCloud(input),
  disconnectCloud: () => rpc.request.disconnectCloud(),
  syncNow: () => rpc.request.syncNow(),
  openNativeFileDialog: () => rpc.request.openNativeFileDialog(),
  showNativeMessage: (input) => rpc.request.showNativeMessage(input),
  showNativeNotification: () => rpc.request.showNativeNotification(),
  writeNativeClipboard: (input) => rpc.request.writeNativeClipboard(input),
  readNativeClipboard: () => rpc.request.readNativeClipboard(),
  showNativeContextMenu: () => rpc.request.showNativeContextMenu(),
  showNativeTextPrompt: (input) => rpc.request.showNativeTextPrompt(input),
  openNativeExternal: (input) => rpc.request.openNativeExternal(input),
  getNativeWindowDescriptor: (input) => rpc.request.getNativeWindowDescriptor(input),
  openNativeWindow: (input) => rpc.request.openNativeWindow(input),
  closeNativeWindow: (input) => rpc.request.closeNativeWindow(input ?? currentWindowInput()),
  minimizeNativeWindow: (input) => rpc.request.minimizeNativeWindow(input ?? currentWindowInput()),
  maximizeNativeWindow: (input) => rpc.request.maximizeNativeWindow(input ?? currentWindowInput()),
  focusNativeWindow: (input) => rpc.request.focusNativeWindow(input),
  setNativeWindowTitle: (input) => rpc.request.setNativeWindowTitle(input),
};

const runtimeBridge: DesktopBridge = {
  getEnvironment: () => rpc.request.getDesktopEnvironment(),
  openFileDialog: async () => {
    const result = await rpc.request.openNativeFileDialog();
    if (!result.ok) return result;
    return { ok: true, data: { paths: result.data.paths ?? [] } };
  },
  showMessage: async (input) => {
    const result = await rpc.request.showNativeMessage({
      type: input.type,
      title: input.title ?? "Desktop",
      message: input.message,
      detail: input.detail,
    });
    if (!result.ok) return result;
    return { ok: true, data: {} };
  },
  showNotification: async (input) => {
    const result = await rpc.request.showNativeNotification({
      title: input.title,
      subtitle: input.subtitle,
      body: input.body,
    });
    if (!result.ok) return result;
    return { ok: true, data: undefined };
  },
  clipboardWriteText: async (value) => {
    const result = await rpc.request.writeNativeClipboard({ value });
    if (!result.ok) return result;
    return { ok: true, data: undefined };
  },
  clipboardReadText: async () => {
    const result = await rpc.request.readNativeClipboard();
    if (!result.ok) return result;
    return { ok: true, data: result.data.value ?? "" };
  },
  showContextMenu: async (items) => {
    const result = await rpc.request.showNativeContextMenu({ items });
    if (!result.ok) return result;
    return { ok: true, data: undefined };
  },
  openExternal: async (url) => {
    const result = await rpc.request.openNativeExternal({ url });
    if (!result.ok) return result;
    return { ok: true, data: true };
  },
  closeWindow: () => rpc.request.closeNativeWindow(currentWindowInput()),
  minimizeWindow: () => rpc.request.minimizeNativeWindow(currentWindowInput()),
  maximizeWindow: () => rpc.request.maximizeNativeWindow(currentWindowInput()),
  getCurrentWindowDescriptor: () => rpc.request.getNativeWindowDescriptor(currentWindowInput()),
  openWindow: (input) => rpc.request.openNativeWindow(input),
  closeWindowById: (input) => rpc.request.closeNativeWindow(input),
  focusWindow: (input) => rpc.request.focusNativeWindow(input),
  setWindowTitle: (input) => rpc.request.setNativeWindowTitle(input),
};

window.cloudDesktop = bridge;
installDesktopBridge(runtimeBridge);

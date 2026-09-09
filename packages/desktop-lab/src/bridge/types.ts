import type { User } from "@k2b/cloud/contracts";
import type {
  DesktopWindowDescriptor,
  DesktopWindowIdInput,
  DesktopWindowOpenInput,
  DesktopWindowRefData,
  DesktopWindowSetTitleInput,
} from "@k2b/cloud/desktop";
import type { DesktopCredentialKind } from "../cloud/sync-contract";

export type DesktopMode = "unset" | "local" | "cloud";

export type SyncStatus = {
  state: "idle" | "syncing" | "error";
  message: string;
  lastSyncAt: string | null;
};

export type CloudConnection = {
  baseUrl: string;
  credentialKind: DesktopCredentialKind;
  user: Pick<User, "id" | "uid" | "displayName" | "profile" | "provider" | "roles">;
  connectedAt: string;
  lastVerifiedAt: string | null;
};

export type DesktopLabState = {
  mode: DesktopMode;
  localNote: string;
  cloud: CloudConnection | null;
  sync: SyncStatus;
};

export type MarkdownFileNode = {
  kind: "file";
  id: string;
  name: string;
  path: string;
  relativePath: string;
  size: number;
  updatedAt: string;
};

export type MarkdownDirectoryNode = {
  kind: "directory";
  id: string;
  name: string;
  path: string;
  relativePath: string;
  children: MarkdownTreeNode[];
};

export type MarkdownTreeNode = MarkdownFileNode | MarkdownDirectoryNode;

export type MarkdownFolder = {
  id: string;
  name: string;
  path: string;
  addedAt: string;
  fileCount: number;
  tree: MarkdownTreeNode[];
};

export type MarkdownWorkspace = {
  folders: MarkdownFolder[];
  lastFilePath: string | null;
};

export type MarkdownFileContent = {
  path: string;
  folderId: string | null;
  name: string;
  markdown: string;
  updatedAt: string;
  size: number;
};

export type MarkdownPathInput = {
  path: string;
};

export type SaveMarkdownFileInput = {
  path: string;
  markdown: string;
};

export type CreateMarkdownFileInput = {
  folderId: string;
  name: string;
};

export type RenameMarkdownFileInput = {
  path: string;
  name: string;
};

export type DeleteMarkdownFileInput = {
  path: string;
};

export type DesktopPlatform = "browser" | "macos" | "linux" | "windows";

export type DesktopEnvironment = {
  runtime: "browser" | "electrobun";
  platform: DesktopPlatform;
  windowControls: "browser" | "native-inset" | "system-titlebar";
  supportsNativeDialogs: boolean;
  supportsNativeMenus: boolean;
  supportsContextMenus: boolean;
};

export type ConnectCloudInput = {
  baseUrl: string;
  adminToken: string;
};

export type SaveLocalNoteInput = {
  value: string;
};

export type SetModeInput = {
  mode: Exclude<DesktopMode, "unset">;
};

export type NativeMessageInput = {
  type?: "info" | "warning" | "error" | "question";
  title: string;
  message: string;
  detail?: string;
};

export type NativeClipboardInput = {
  value: string;
};

export type NativeNotificationInput = {
  title: string;
  subtitle?: string;
  body?: string;
};

export type NativeContextMenuInput = {
  items?: Array<{ type: "divider" } | { label: string; action?: string; role?: string; enabled?: boolean }>;
};

export type NativeExternalInput = {
  url: string;
};

export type NativeTextPromptInput = {
  title: string;
  message: string;
  defaultValue?: string;
};

export type NativeDemoResult = {
  label: string;
  detail: string;
  value?: string;
  paths?: string[];
};

export type BridgeResult<T> = { ok: true; data: T } | { ok: false; error: string };

export type DesktopLabBridge = {
  getState: () => Promise<BridgeResult<DesktopLabState>>;
  getDesktopEnvironment: () => Promise<BridgeResult<DesktopEnvironment>>;
  getMarkdownWorkspace: () => Promise<BridgeResult<MarkdownWorkspace>>;
  addMarkdownFolder: () => Promise<BridgeResult<MarkdownWorkspace>>;
  removeMarkdownFolder: (input: { id: string }) => Promise<BridgeResult<MarkdownWorkspace>>;
  rescanMarkdownFolders: () => Promise<BridgeResult<MarkdownWorkspace>>;
  readMarkdownFile: (input: MarkdownPathInput) => Promise<BridgeResult<MarkdownFileContent>>;
  saveMarkdownFile: (input: SaveMarkdownFileInput) => Promise<BridgeResult<MarkdownFileContent>>;
  createMarkdownFile: (input: CreateMarkdownFileInput) => Promise<BridgeResult<MarkdownFileContent>>;
  renameMarkdownFile: (input: RenameMarkdownFileInput) => Promise<BridgeResult<MarkdownFileContent>>;
  deleteMarkdownFile: (input: DeleteMarkdownFileInput) => Promise<BridgeResult<MarkdownWorkspace>>;
  setMode: (input: SetModeInput) => Promise<BridgeResult<DesktopLabState>>;
  saveLocalNote: (input: SaveLocalNoteInput) => Promise<BridgeResult<DesktopLabState>>;
  connectCloud: (input: ConnectCloudInput) => Promise<BridgeResult<DesktopLabState>>;
  disconnectCloud: () => Promise<BridgeResult<DesktopLabState>>;
  syncNow: () => Promise<BridgeResult<DesktopLabState>>;
  openNativeFileDialog: () => Promise<BridgeResult<NativeDemoResult>>;
  showNativeMessage: (input: NativeMessageInput) => Promise<BridgeResult<NativeDemoResult>>;
  showNativeNotification: (input?: NativeNotificationInput) => Promise<BridgeResult<NativeDemoResult>>;
  writeNativeClipboard: (input: NativeClipboardInput) => Promise<BridgeResult<NativeDemoResult>>;
  readNativeClipboard: () => Promise<BridgeResult<NativeDemoResult>>;
  showNativeContextMenu: (input?: NativeContextMenuInput) => Promise<BridgeResult<NativeDemoResult>>;
  showNativeTextPrompt: (input: NativeTextPromptInput) => Promise<BridgeResult<NativeDemoResult>>;
  openNativeExternal: (input: NativeExternalInput) => Promise<BridgeResult<NativeDemoResult>>;
  getNativeWindowDescriptor?: (input: DesktopWindowIdInput) => Promise<BridgeResult<DesktopWindowDescriptor | null>>;
  openNativeWindow?: (input: DesktopWindowOpenInput) => Promise<BridgeResult<DesktopWindowRefData>>;
  closeNativeWindow?: (input?: DesktopWindowIdInput) => Promise<BridgeResult<void>>;
  minimizeNativeWindow?: (input?: DesktopWindowIdInput) => Promise<BridgeResult<void>>;
  maximizeNativeWindow?: (input?: DesktopWindowIdInput) => Promise<BridgeResult<void>>;
  focusNativeWindow?: (input: DesktopWindowIdInput) => Promise<BridgeResult<void>>;
  setNativeWindowTitle?: (input: DesktopWindowSetTitleInput) => Promise<BridgeResult<void>>;
};

declare global {
  interface Window {
    cloudDesktop?: DesktopLabBridge;
  }
}

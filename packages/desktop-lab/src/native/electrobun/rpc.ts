import type { RPCSchema } from "electrobun";
import type {
  DesktopWindowDescriptor,
  DesktopWindowIdInput,
  DesktopWindowOpenInput,
  DesktopWindowRefData,
  DesktopWindowSetTitleInput,
} from "@k2b/cloud/desktop";
import type {
  BridgeResult,
  ConnectCloudInput,
  DesktopEnvironment,
  DesktopLabState,
  MarkdownFileContent,
  MarkdownPathInput,
  MarkdownWorkspace,
  CreateMarkdownFileInput,
  DeleteMarkdownFileInput,
  NativeClipboardInput,
  NativeContextMenuInput,
  NativeDemoResult,
  NativeExternalInput,
  NativeMessageInput,
  NativeNotificationInput,
  NativeTextPromptInput,
  RenameMarkdownFileInput,
  SaveLocalNoteInput,
  SaveMarkdownFileInput,
  SetModeInput,
} from "../../bridge/types";

export type DesktopLabRPC = {
  bun: RPCSchema<{
    requests: {
      getState: {
        params: undefined;
        response: BridgeResult<DesktopLabState>;
      };
      getDesktopEnvironment: {
        params: undefined;
        response: BridgeResult<DesktopEnvironment>;
      };
      getMarkdownWorkspace: {
        params: undefined;
        response: BridgeResult<MarkdownWorkspace>;
      };
      addMarkdownFolder: {
        params: undefined;
        response: BridgeResult<MarkdownWorkspace>;
      };
      removeMarkdownFolder: {
        params: { id: string };
        response: BridgeResult<MarkdownWorkspace>;
      };
      rescanMarkdownFolders: {
        params: undefined;
        response: BridgeResult<MarkdownWorkspace>;
      };
      readMarkdownFile: {
        params: MarkdownPathInput;
        response: BridgeResult<MarkdownFileContent>;
      };
      saveMarkdownFile: {
        params: SaveMarkdownFileInput;
        response: BridgeResult<MarkdownFileContent>;
      };
      createMarkdownFile: {
        params: CreateMarkdownFileInput;
        response: BridgeResult<MarkdownFileContent>;
      };
      renameMarkdownFile: {
        params: RenameMarkdownFileInput;
        response: BridgeResult<MarkdownFileContent>;
      };
      deleteMarkdownFile: {
        params: DeleteMarkdownFileInput;
        response: BridgeResult<MarkdownWorkspace>;
      };
      setMode: {
        params: SetModeInput;
        response: BridgeResult<DesktopLabState>;
      };
      saveLocalNote: {
        params: SaveLocalNoteInput;
        response: BridgeResult<DesktopLabState>;
      };
      connectCloud: {
        params: ConnectCloudInput;
        response: BridgeResult<DesktopLabState>;
      };
      disconnectCloud: {
        params: undefined;
        response: BridgeResult<DesktopLabState>;
      };
      syncNow: {
        params: undefined;
        response: BridgeResult<DesktopLabState>;
      };
      openNativeFileDialog: {
        params: undefined;
        response: BridgeResult<NativeDemoResult>;
      };
      showNativeMessage: {
        params: NativeMessageInput;
        response: BridgeResult<NativeDemoResult>;
      };
      showNativeNotification: {
        params: NativeNotificationInput | undefined;
        response: BridgeResult<NativeDemoResult>;
      };
      writeNativeClipboard: {
        params: NativeClipboardInput;
        response: BridgeResult<NativeDemoResult>;
      };
      readNativeClipboard: {
        params: undefined;
        response: BridgeResult<NativeDemoResult>;
      };
      showNativeContextMenu: {
        params: NativeContextMenuInput | undefined;
        response: BridgeResult<NativeDemoResult>;
      };
      showNativeTextPrompt: {
        params: NativeTextPromptInput;
        response: BridgeResult<NativeDemoResult>;
      };
      openNativeExternal: {
        params: NativeExternalInput;
        response: BridgeResult<NativeDemoResult>;
      };
      closeNativeWindow: {
        params: DesktopWindowIdInput | undefined;
        response: BridgeResult<void>;
      };
      minimizeNativeWindow: {
        params: DesktopWindowIdInput | undefined;
        response: BridgeResult<void>;
      };
      maximizeNativeWindow: {
        params: DesktopWindowIdInput | undefined;
        response: BridgeResult<void>;
      };
      openNativeWindow: {
        params: DesktopWindowOpenInput;
        response: BridgeResult<DesktopWindowRefData>;
      };
      getNativeWindowDescriptor: {
        params: DesktopWindowIdInput;
        response: BridgeResult<DesktopWindowDescriptor | null>;
      };
      focusNativeWindow: {
        params: DesktopWindowIdInput;
        response: BridgeResult<void>;
      };
      setNativeWindowTitle: {
        params: DesktopWindowSetTitleInput;
        response: BridgeResult<void>;
      };
    };
    messages: Record<never, never>;
  }>;
  webview: RPCSchema<{
    requests: Record<never, never>;
    messages: Record<never, never>;
  }>;
};

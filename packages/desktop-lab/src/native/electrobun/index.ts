import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import type { DesktopWindowOpenInput } from "@k2b/cloud/desktop";
import type {
  BridgeResult,
  DesktopEnvironment,
  MarkdownWorkspace,
  NativeContextMenuInput,
  NativeDemoResult,
  NativeMessageInput,
  NativeNotificationInput,
  NativeTextPromptInput,
} from "../../bridge/types";
import { desktopApp } from "../../desktop-app";
import type { DesktopLabRPC } from "./rpc";

const ok = <T>(data: T): BridgeResult<T> => ({ ok: true, data });
const fail = <T>(error: unknown): BridgeResult<T> => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error),
});

const commandExists = (command: string) => spawnSync("command", ["-v", command], { shell: true }).status === 0;

const platform = (): DesktopEnvironment["platform"] => {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") return "linux";
  return "browser";
};

const desktopEnvironment = (): DesktopEnvironment => {
  const currentPlatform = platform();
  return {
    runtime: "electrobun",
    platform: currentPlatform,
    windowControls: currentPlatform === "macos" ? "native-inset" : "system-titlebar",
    supportsNativeDialogs: true,
    supportsNativeMenus: true,
    supportsContextMenus: currentPlatform !== "linux",
  };
};

const macosTrafficLightPosition = { x: 16, y: 18 };

const startDesktopLab = async () => {
  const [{ BrowserView, BrowserWindow, ApplicationMenu, ContextMenu, Utils }, { createDesktopLabService }] = await Promise.all([
    import("electrobun/bun"),
    import("../../main/service"),
  ]);

  const service = createDesktopLabService({
    dataDir: join(homedir(), ".stuve", "desktop-lab"),
  });

  const nativeDemo = (label: string, detail: string, extra: Partial<NativeDemoResult> = {}) => ok({ label, detail, ...extra });

  const showMessage = (input: NativeMessageInput) => {
    try {
      setTimeout(() => {
        void Utils.showMessageBox({
          type: input.type ?? "info",
          title: input.title,
          message: input.message,
          detail: input.detail,
          buttons: ["OK", "Cancel"],
          defaultId: 0,
          cancelId: 1,
        });
      }, 0);
      return nativeDemo("Native message box", "Message box opened by the Bun process.");
    } catch (error) {
      return fail<NativeDemoResult>(error);
    }
  };

  const openFiles = () => {
    try {
      setTimeout(() => {
        void Utils.openFileDialog({
          startingFolder: Utils.paths.home,
          canChooseFiles: true,
          canChooseDirectory: true,
          allowsMultipleSelection: true,
        });
      }, 0);
      return nativeDemo("Native file dialog", "File dialog opened by the Bun process.");
    } catch (error) {
      return fail<NativeDemoResult>(error);
    }
  };

  const addMarkdownFolder = async () => {
    try {
      const paths = await Utils.openFileDialog({
        startingFolder: Utils.paths.home,
        canChooseFiles: false,
        canChooseDirectory: true,
        allowsMultipleSelection: false,
      });
      const folderPath = paths.find((path) => path.trim().length > 0);
      if (!folderPath) return service.getMarkdownWorkspace();
      return service.addMarkdownFolderPath(folderPath);
    } catch (error) {
      return fail<MarkdownWorkspace>(error);
    }
  };

  const showNotification = (input?: NativeNotificationInput) => {
    try {
      Utils.showNotification({
        title: input?.title ?? "Markdown Desk",
        subtitle: input?.subtitle ?? "Native notification",
        body: input?.body ?? "This notification was sent from the Electrobun Bun process.",
      });
      return nativeDemo("Native notification", "Notification request sent to the operating system.");
    } catch (error) {
      return fail<NativeDemoResult>(error);
    }
  };

  const showContextMenu = (input?: NativeContextMenuInput) => {
    try {
      if (desktopEnvironment().platform === "linux") {
        return fail<NativeDemoResult>("Electrobun context menus are not supported on Linux yet.");
      }
      ContextMenu.showContextMenu(
        input?.items ?? [
          { label: "Show Message", action: "native:message" },
          { label: "Notify", action: "native:notification" },
          { type: "divider" },
          { label: "Copy", role: "copy" },
          { label: "Paste", role: "paste" },
        ],
      );
      return nativeDemo("Native context menu", "Context menu opened.");
    } catch (error) {
      return fail<NativeDemoResult>(error);
    }
  };

  const showTextPrompt = (input: NativeTextPromptInput) => {
    try {
      if (env.platform === "macos") {
        const result = spawnSync(
          "osascript",
          [
            "-e",
            `display dialog ${JSON.stringify(input.message)} default answer ${JSON.stringify(input.defaultValue ?? "")} with title ${JSON.stringify(input.title)} buttons {"Cancel", "OK"} default button "OK" cancel button "Cancel"`,
            "-e",
            "text returned of result",
          ],
          { encoding: "utf8" },
        );
        if (result.status !== 0) return nativeDemo("Native prompt", "Prompt cancelled.");
        return nativeDemo("Native prompt", "System text prompt completed.", { value: result.stdout.trim() });
      }

      if (env.platform === "linux" && commandExists("kdialog")) {
        const result = spawnSync("kdialog", ["--title", input.title, "--inputbox", input.message, input.defaultValue ?? ""], {
          encoding: "utf8",
        });
        if (result.status !== 0) return nativeDemo("Native prompt", "Prompt cancelled.");
        return nativeDemo("Native prompt", "System text prompt completed.", { value: result.stdout.trim() });
      }

      if (env.platform === "linux" && commandExists("zenity")) {
        const result = spawnSync(
          "zenity",
          ["--entry", "--title", input.title, "--text", input.message, "--entry-text", input.defaultValue ?? ""],
          {
            encoding: "utf8",
          },
        );
        if (result.status !== 0) return nativeDemo("Native prompt", "Prompt cancelled.");
        return nativeDemo("Native prompt", "System text prompt completed.", { value: result.stdout.trim() });
      }

      return fail<NativeDemoResult>("Native text prompts are not available on this platform yet.");
    } catch (error) {
      return fail<NativeDemoResult>(error);
    }
  };

  const openExternal = (url: string) => {
    try {
      const opened = Utils.openExternal(url);
      return nativeDemo("Native external open", opened ? `Opened ${url}` : `The OS declined to open ${url}.`, { value: url });
    } catch (error) {
      return fail<NativeDemoResult>(error);
    }
  };

  const env = desktopEnvironment();
  type AppWindow = InstanceType<typeof BrowserWindow>;
  const windows = new Map<string, AppWindow>();
  const windowDescriptors = new Map<string, DesktopWindowOpenInput["descriptor"]>();
  let primaryWindow: AppWindow | null = null;
  let rpc: any;

  const getWindow = (input?: { id?: string } | null) => (input?.id ? windows.get(input.id) : primaryWindow);

  const createAppWindow = (input?: DesktopWindowOpenInput) => {
    const next = new BrowserWindow({
      title: input?.options?.title ?? desktopApp.name,
      url: "views://desktop-lab/index.html",
      preload: "views://desktop-bridge/preload.js",
      hidden: true,
      titleBarStyle: env.platform === "macos" ? "hiddenInset" : "default",
      transparent: false,
      trafficLightOffset: env.platform === "macos" ? macosTrafficLightPosition : undefined,
      frame: {
        width: input?.options?.width ?? desktopApp.window?.width ?? 1100,
        height: input?.options?.height ?? desktopApp.window?.height ?? 760,
        x: input?.options?.x ?? 80 + windows.size * 24,
        y: input?.options?.y ?? 80 + windows.size * 24,
      },
      rpc,
    });
    windows.set(String(next.id), next);
    if (input) windowDescriptors.set(String(next.id), input.descriptor);
    next.on("close", () => {
      windows.delete(String(next.id));
      windowDescriptors.delete(String(next.id));
    });

    setTimeout(() => {
      if (env.platform === "macos") next.setWindowButtonPosition(macosTrafficLightPosition.x, macosTrafficLightPosition.y);
      next.show();
      if (input?.options?.activate ?? true) next.activate();
    }, 100);

    return next;
  };

  rpc = BrowserView.defineRPC<DesktopLabRPC>({
    maxRequestTime: 300_000,
    handlers: {
      requests: {
        getState: () => service.getState(),
        getDesktopEnvironment: () => ok(desktopEnvironment()),
        getMarkdownWorkspace: () => service.getMarkdownWorkspace(),
        addMarkdownFolder,
        removeMarkdownFolder: (input) => service.removeMarkdownFolder(input),
        rescanMarkdownFolders: () => service.rescanMarkdownFolders(),
        readMarkdownFile: (input) => service.readMarkdownFile(input),
        saveMarkdownFile: (input) => service.saveMarkdownFile(input),
        createMarkdownFile: (input) => service.createMarkdownFile(input),
        renameMarkdownFile: (input) => service.renameMarkdownFile(input),
        deleteMarkdownFile: (input) => service.deleteMarkdownFile(input),
        setMode: (input) => service.setMode(input),
        saveLocalNote: (input) => service.saveLocalNote(input),
        connectCloud: (input) => service.connectCloud(input),
        disconnectCloud: () => service.disconnectCloud(),
        syncNow: () => service.syncNow(),
        openNativeFileDialog: openFiles,
        showNativeMessage: showMessage,
        showNativeNotification: showNotification,
        writeNativeClipboard: (input) => {
          try {
            Utils.clipboardWriteText(input.value);
            return nativeDemo("Native clipboard write", "Text written to the system clipboard.", { value: input.value });
          } catch (error) {
            return fail<NativeDemoResult>(error);
          }
        },
        readNativeClipboard: () => {
          try {
            const value = Utils.clipboardReadText() ?? "";
            return nativeDemo("Native clipboard read", value || "Clipboard has no text.", { value });
          } catch (error) {
            return fail<NativeDemoResult>(error);
          }
        },
        showNativeContextMenu: showContextMenu,
        showNativeTextPrompt: showTextPrompt,
        openNativeExternal: (input) => openExternal(input.url),
        openNativeWindow: (input) => {
          const next = createAppWindow(input);
          return ok({ id: String(next.id) });
        },
        getNativeWindowDescriptor: (input) => ok(windowDescriptors.get(input.id) ?? null),
        closeNativeWindow: (input) => {
          getWindow(input)?.close();
          return ok(undefined);
        },
        minimizeNativeWindow: (input) => {
          getWindow(input)?.minimize();
          return ok(undefined);
        },
        maximizeNativeWindow: (input) => {
          getWindow(input)?.maximize();
          return ok(undefined);
        },
        focusNativeWindow: (input) => {
          getWindow(input)?.activate();
          return ok(undefined);
        },
        setNativeWindowTitle: (input) => {
          getWindow(input)?.setTitle(input.title);
          return ok(undefined);
        },
      },
      messages: {},
    },
  });

  const closeService = () => {
    service.close();
  };

  primaryWindow = createAppWindow();

  globalThis.__cloudDesktopLabWindow = primaryWindow;

  ApplicationMenu.setApplicationMenu([
    {
      label: "Markdown Desk",
      submenu: [
        { label: "About Markdown Desk", action: "native:message" },
        { type: "divider" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "showAll" },
        { type: "divider" },
        { label: "Quit Markdown Desk", action: "native:quit", accelerator: "CommandOrControl+Q" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "Open File Dialog", action: "native:open-file" },
        { label: "Open Cloud Docs", action: "native:open-docs" },
        { type: "divider" },
        { role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "divider" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [{ role: "toggleFullScreen" }, { label: "Run Sync Check", action: "native:sync" }],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "bringAllToFront" }],
    },
    {
      label: "Native",
      submenu: [
        { label: "Message Box", action: "native:message" },
        { label: "Notification", action: "native:notification" },
        { label: "Context Menu", action: "native:context-menu" },
      ],
    },
  ]);

  ApplicationMenu.on("application-menu-clicked", (event) => {
    const action = (event as { data?: { action?: string } }).data?.action;
    if (action === "native:message") void showMessage({ title: "Markdown Desk", message: "This is a native Electrobun message box." });
    if (action === "native:open-file") void openFiles();
    if (action === "native:notification") void showNotification();
    if (action === "native:context-menu") void showContextMenu();
    if (action === "native:open-docs") void openExternal("https://docs.electrobunny.ai/electrobun/");
    if (action === "native:sync") void service.syncNow();
    if (action === "native:quit") Utils.quit();
  });

  ContextMenu.on("context-menu-clicked", (event) => {
    const action = (event as { data?: { action?: string } }).data?.action;
    if (action === "native:message") void showMessage({ title: "Context menu", message: "The native context menu action reached Bun." });
    if (action === "native:notification") void showNotification();
  });

  process.on("SIGINT", closeService);
  process.on("SIGTERM", closeService);
};

startDesktopLab().catch((error) => {
  console.error("Markdown Desk native startup failed", error);
});

declare global {
  var __cloudDesktopLabWindow: unknown;
}

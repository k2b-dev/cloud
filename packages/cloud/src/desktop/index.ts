export type DesktopPlatform = "browser" | "macos" | "linux" | "windows";
export type DesktopRuntime = "browser" | "electrobun";
export type DesktopWindowControls = "browser" | "native-inset" | "system-titlebar" | "custom";

export type DesktopEnvironment = {
  runtime: DesktopRuntime;
  platform: DesktopPlatform;
  windowControls: DesktopWindowControls;
  supportsNativeDialogs: boolean;
  supportsNativeMenus: boolean;
  supportsContextMenus: boolean;
};

export type DesktopResult<T> = { ok: true; data: T } | { ok: false; error: string };

export type DesktopFileDialogOptions = {
  multiple?: boolean;
  directories?: boolean;
  files?: boolean;
  startingFolder?: string;
};

export type DesktopFileDialogResult = {
  paths: string[];
};

export type DesktopMessageOptions = {
  type?: "info" | "warning" | "error" | "question";
  title?: string;
  message: string;
  detail?: string;
  buttons?: string[];
};

export type DesktopMessageResult = {
  buttonIndex?: number;
};

export type DesktopNotificationOptions = {
  title: string;
  subtitle?: string;
  body?: string;
};

export type DesktopContextMenuItem = { type: "divider" } | { label: string; action?: string; role?: string; enabled?: boolean };

export type DesktopLogger = {
  debug: (message: string, metadata?: Record<string, unknown>) => void;
  info: (message: string, metadata?: Record<string, unknown>) => void;
  warn: (message: string, metadata?: Record<string, unknown>) => void;
  error: (message: string, metadata?: Record<string, unknown>) => void;
};

export type DesktopTaskState = "idle" | "running" | "scheduled" | "error" | "stopped";

export type DesktopTaskStatus = {
  id: string;
  state: DesktopTaskState;
  runCount: number;
  failureCount: number;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastError?: string;
  nextRunAt?: string;
};

export type DesktopTaskRetryOptions = {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
};

export type DesktopTaskRunContext = {
  id: string;
  app: DesktopAppConfig;
  sql: DesktopSql;
  logger: DesktopLogger;
  signal: AbortSignal;
};

export type DesktopTaskDefinition = {
  intervalMs?: number;
  runOnStart?: boolean;
  retry?: DesktopTaskRetryOptions;
  run: (ctx: DesktopTaskRunContext) => void | Promise<void>;
};

export type DesktopTaskSupervisor = {
  register: (id: string, definition: DesktopTaskDefinition) => void;
  every: (id: string, definition: DesktopTaskDefinition & { intervalMs: number }) => void;
  submit: (id: string) => Promise<DesktopTaskStatus>;
  status: (id: string) => DesktopTaskStatus | null;
  list: () => DesktopTaskStatus[];
  stop: () => Promise<void>;
};

export type DesktopLifecycleContext = {
  app: DesktopAppConfig;
  desktop: typeof desktop;
  sql: DesktopSql;
  logger: DesktopLogger;
  signal: AbortSignal;
  tasks: DesktopTaskSupervisor;
};

export type DesktopLifecycle = {
  setup?: (ctx: DesktopLifecycleContext) => void | Promise<void>;
  start?: (ctx: DesktopLifecycleContext) => void | Promise<void>;
  stop?: (ctx: DesktopLifecycleContext) => void | Promise<void>;
};

export const desktopWindowDescriptorKind = "cloud-desktop-window" as const;
export const desktopWindowSearchParams = {
  name: "__cloudDesktopWindow",
  props: "__cloudDesktopWindowProps",
} as const;

export type DesktopWindowDescriptor = {
  kind: typeof desktopWindowDescriptorKind;
  name: string;
  props: string;
};

export type DesktopWindowOpenOptions = {
  title?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  activate?: boolean;
};

export type DesktopWindowOpenInput = {
  descriptor: DesktopWindowDescriptor;
  options?: DesktopWindowOpenOptions;
};

export type DesktopWindowIdInput = {
  id: string;
};

export type DesktopWindowSetTitleInput = DesktopWindowIdInput & {
  title: string;
};

export type DesktopWindowRefData = {
  id: string;
};

export type DesktopWindowRef = DesktopWindowRefData & {
  close: () => Promise<void>;
  focus: () => Promise<void>;
  setTitle: (title: string) => Promise<void>;
};

export type DesktopBridge = {
  getEnvironment?: () => Promise<DesktopResult<DesktopEnvironment>>;
  openFileDialog?: (options?: DesktopFileDialogOptions) => Promise<DesktopResult<DesktopFileDialogResult>>;
  showMessage?: (options: DesktopMessageOptions) => Promise<DesktopResult<DesktopMessageResult>>;
  showNotification?: (options: DesktopNotificationOptions) => Promise<DesktopResult<void>>;
  clipboardWriteText?: (value: string) => Promise<DesktopResult<void>>;
  clipboardReadText?: () => Promise<DesktopResult<string>>;
  showContextMenu?: (items: DesktopContextMenuItem[]) => Promise<DesktopResult<void>>;
  openExternal?: (url: string) => Promise<DesktopResult<boolean>>;
  closeWindow?: () => Promise<DesktopResult<void>>;
  minimizeWindow?: () => Promise<DesktopResult<void>>;
  maximizeWindow?: () => Promise<DesktopResult<void>>;
  getCurrentWindowDescriptor?: () => Promise<DesktopResult<DesktopWindowDescriptor | null>>;
  openWindow?: (input: DesktopWindowOpenInput) => Promise<DesktopResult<DesktopWindowRefData>>;
  closeWindowById?: (input: DesktopWindowIdInput) => Promise<DesktopResult<void>>;
  focusWindow?: (input: DesktopWindowIdInput) => Promise<DesktopResult<void>>;
  setWindowTitle?: (input: DesktopWindowSetTitleInput) => Promise<DesktopResult<void>>;
  submitTask?: (id: string) => Promise<DesktopResult<DesktopTaskStatus>>;
  getTaskStatus?: (id: string) => Promise<DesktopResult<DesktopTaskStatus | null>>;
  listTasks?: () => Promise<DesktopResult<DesktopTaskStatus[]>>;
};

export type DesktopAppMenuItem =
  | { type: "divider" }
  | { role: string }
  | { label: string; action?: string; onClick?: (ctx: DesktopActionContext) => void | Promise<void>; enabled?: boolean };

export type DesktopAppMenu = Array<{
  label: string;
  items: DesktopAppMenuItem[];
}>;

export type DesktopAppConfig = {
  name: string;
  identifier: string;
  version?: string;
  routing?: "path" | "hash" | "none";
  window?: {
    width?: number;
    height?: number;
    titleBar?: "default" | "hidden-inset" | "hidden" | "custom";
  };
  menu?: DesktopAppMenu;
  lifecycle?: DesktopLifecycle;
};

export type DesktopActionContext = {
  desktop: typeof desktop;
};

export type DesktopSql = (<Row = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]) => Row[]) & {
  transaction: <T>(fn: () => T) => T;
  db: unknown;
};

const browserEnvironment: DesktopEnvironment = {
  runtime: "browser",
  platform: "browser",
  windowControls: "browser",
  supportsNativeDialogs: false,
  supportsNativeMenus: false,
  supportsContextMenus: false,
};

let bridgeOverride: DesktopBridge | null = null;

const hasWindow = () => typeof window !== "undefined";

const bridge = (): DesktopBridge | null => bridgeOverride ?? (hasWindow() ? (window.cloudDesktopRuntime ?? null) : null);

const unsupported = async <T>(label: string): Promise<DesktopResult<T>> => ({
  ok: false,
  error: `${label} requires a desktop runtime.`,
});

const unwrap = async <T>(result: Promise<DesktopResult<T>>): Promise<T> => {
  const value = await result;
  if (!value.ok) throw new Error(value.error);
  return value.data;
};

const result = async <T>(fn: () => T | Promise<T>): Promise<DesktopResult<T>> => {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
};

const emitNavigation = () => {
  if (!hasWindow()) return;
  window.dispatchEvent(new CustomEvent("cloud-desktop:navigation"));
};

const isDesktopWindowDescriptor = (value: unknown): value is DesktopWindowDescriptor =>
  Boolean(
    value &&
      typeof value === "object" &&
      (value as { kind?: unknown }).kind === desktopWindowDescriptorKind &&
      typeof (value as { name?: unknown }).name === "string" &&
      typeof (value as { props?: unknown }).props === "string",
  );

const descriptorUrl = (descriptor: DesktopWindowDescriptor): string => {
  const url = hasWindow() ? new URL(window.location.href) : new URL("http://desktop.local/");
  const params = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : "");
  params.set(desktopWindowSearchParams.name, descriptor.name);
  params.set(desktopWindowSearchParams.props, descriptor.props);
  url.hash = params.toString();
  return `${url.pathname}${url.search}${url.hash}`;
};

export const readDesktopWindowDescriptor = (): DesktopWindowDescriptor | null => {
  if (!hasWindow()) return null;
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.search);
  const name = params.get(desktopWindowSearchParams.name);
  const props = params.get(desktopWindowSearchParams.props);
  return name && props ? { kind: desktopWindowDescriptorKind, name, props } : null;
};

const windowRef = (data: DesktopWindowRefData, browserWindow?: Window | null): DesktopWindowRef => ({
  id: data.id,
  close: () =>
    browserWindow
      ? Promise.resolve(browserWindow.close())
      : unwrap(bridge()?.closeWindowById?.({ id: data.id }) ?? unsupported("Native windows")),
  focus: () =>
    browserWindow
      ? Promise.resolve(browserWindow.focus())
      : unwrap(bridge()?.focusWindow?.({ id: data.id }) ?? unsupported("Native windows")),
  setTitle: (title) =>
    browserWindow
      ? Promise.resolve(undefined)
      : unwrap(bridge()?.setWindowTitle?.({ id: data.id, title }) ?? unsupported("Native windows")),
});

const runtimeRequire = (): ((id: string) => unknown) | null => {
  const importMetaRequire = (import.meta as unknown as { require?: (id: string) => unknown }).require;
  if (importMetaRequire) return importMetaRequire;
  try {
    return Function("return typeof require === 'function' ? require : null")() as ((id: string) => unknown) | null;
  } catch {
    return null;
  }
};

let sqlInstance: DesktopSql | null = null;

const getSql = (): DesktopSql => {
  if (sqlInstance) return sqlInstance;
  const req = runtimeRequire();
  if (!req || typeof window !== "undefined") throw new Error("desktop.sql is only available in the Bun desktop process.");
  const requireFn = req as (id: string) => unknown;

  const { Database } = requireFn("bun:sqlite") as { Database: new (path: string) => any };
  const { dirname, resolve } = requireFn("node:path") as typeof import("node:path");
  const { mkdirSync } = requireFn("node:fs") as typeof import("node:fs");
  // Declared in the platform registry; this browser-safe module must not import zod-backed config.
  const dbPath = process.env.CLOUD_DESKTOP_SQLITE_PATH ?? resolve(process.cwd(), ".local", "desktop.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = strings.reduce((query, chunk, index) => `${query}${chunk}${index < values.length ? "?" : ""}`, "");
    const prepared = db.query(statement);
    const firstWord = statement.trimStart().split(/\s+/, 1)[0]?.toLowerCase();
    if (firstWord === "select" || firstWord === "pragma" || firstWord === "with") return prepared.all(...values);
    prepared.run(...values);
    return [];
  }) as DesktopSql;

  sql.transaction = (fn) => db.transaction(fn)();
  Object.defineProperty(sql, "db", { value: db, enumerable: true });
  sqlInstance = sql;
  return sql;
};

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });

const chainAbort = (source: AbortSignal, target: AbortController): (() => void) => {
  if (source.aborted) {
    target.abort();
    return () => {};
  }
  const abort = () => target.abort();
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const createConsoleLogger = (source: string): DesktopLogger => {
  const write =
    (level: "debug" | "info" | "warn" | "error") =>
    (message: string, metadata?: Record<string, unknown>): void => {
      const prefix = `[desktop:${source}] ${message}`;
      if (metadata) console[level](prefix, metadata);
      else console[level](prefix);
    };
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  };
};

const snapshotTaskStatus = (status: DesktopTaskStatus): DesktopTaskStatus => ({ ...status });

export const createDesktopTaskSupervisor = (options: {
  app: DesktopAppConfig;
  sql?: DesktopSql;
  logger?: DesktopLogger;
  signal?: AbortSignal;
}): DesktopTaskSupervisor => {
  const parentSignal = options.signal ?? new AbortController().signal;
  const sql = options.sql ?? getSql();
  const logger = options.logger ?? createConsoleLogger(options.app.identifier);
  let stopped = false;
  type TaskRecord = {
    definition: DesktopTaskDefinition;
    status: DesktopTaskStatus;
    timer: ReturnType<typeof setTimeout> | null;
    runController: AbortController | null;
    currentRun: Promise<DesktopTaskStatus> | null;
  };
  const records = new Map<string, TaskRecord>();

  const scheduleNext = (id: string, record: TaskRecord): void => {
    if (!record.definition.intervalMs || stopped || parentSignal.aborted || record.status.state === "stopped") return;
    const dueAt = Date.now() + record.definition.intervalMs;
    record.status.nextRunAt = new Date(dueAt).toISOString();
    record.status.state = record.status.lastError ? "error" : "scheduled";
    record.timer = setTimeout(() => {
      record.timer = null;
      void runTask(id, record).catch((error) => {
        logger.error(`Task "${id}" failed`, { error: errorMessage(error) });
      });
    }, record.definition.intervalMs);
  };

  const runTask = async (id: string, record: TaskRecord): Promise<DesktopTaskStatus> => {
    if (record.currentRun) return record.currentRun;
    if (stopped || parentSignal.aborted) throw new Error("Desktop app is stopping.");
    if (record.timer) {
      clearTimeout(record.timer);
      record.timer = null;
    }

    const run = async (): Promise<DesktopTaskStatus> => {
      const controller = new AbortController();
      const unchainAbort = chainAbort(parentSignal, controller);
      record.runController = controller;
      record.status.state = "running";
      record.status.lastStartedAt = new Date().toISOString();
      record.status.nextRunAt = undefined;

      const retry = record.definition.retry;
      const attempts = Math.max(1, retry?.attempts ?? 1);
      const baseMs = Math.max(0, retry?.baseMs ?? 0);
      const maxMs = Math.max(baseMs, retry?.maxMs ?? baseMs);
      let lastError: unknown;

      try {
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
          try {
            await record.definition.run({ id, app: options.app, sql, logger, signal: controller.signal });
            record.status.runCount += 1;
            record.status.failureCount = 0;
            record.status.lastError = undefined;
            record.status.lastFinishedAt = new Date().toISOString();
            record.status.state = "idle";
            return snapshotTaskStatus(record.status);
          } catch (error) {
            lastError = error;
            if (controller.signal.aborted || attempt >= attempts) break;
            const delay = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
            if (delay > 0) await sleep(delay, controller.signal);
          }
        }

        record.status.failureCount += 1;
        record.status.lastError = errorMessage(lastError);
        record.status.lastFinishedAt = new Date().toISOString();
        record.status.state = "error";
        throw lastError instanceof Error ? lastError : new Error(errorMessage(lastError));
      } finally {
        unchainAbort();
        record.runController = null;
        record.currentRun = null;
        if (!stopped && !parentSignal.aborted) scheduleNext(id, record);
      }
    };

    record.currentRun = run();
    return record.currentRun;
  };

  const register = (id: string, definition: DesktopTaskDefinition): void => {
    if (stopped) throw new Error("Desktop task supervisor is stopped.");
    const existing = records.get(id);
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      existing.runController?.abort();
      existing.definition = definition;
      existing.status.state = "idle";
      existing.status.nextRunAt = undefined;
      if (definition.intervalMs) scheduleNext(id, existing);
      if (definition.runOnStart) void runTask(id, existing).catch(() => {});
      return;
    }

    const record: TaskRecord = {
      definition,
      timer: null,
      runController: null,
      currentRun: null,
      status: {
        id,
        state: "idle",
        runCount: 0,
        failureCount: 0,
      },
    };
    records.set(id, record);
    if (definition.intervalMs) scheduleNext(id, record);
    if (definition.runOnStart) void runTask(id, record).catch(() => {});
  };

  const supervisor: DesktopTaskSupervisor = {
    register,
    every: (id, definition) => register(id, definition),
    submit: async (id) => {
      if (stopped) throw new Error("Desktop task supervisor is stopped.");
      const record = records.get(id);
      if (!record) throw new Error(`Unknown desktop task "${id}".`);
      return runTask(id, record);
    },
    status: (id) => {
      const record = records.get(id);
      return record ? snapshotTaskStatus(record.status) : null;
    },
    list: () => Array.from(records.values(), (record) => snapshotTaskStatus(record.status)),
    stop: async () => {
      stopped = true;
      for (const record of records.values()) {
        if (record.timer) clearTimeout(record.timer);
        record.timer = null;
        record.status.nextRunAt = undefined;
        record.status.state = "stopped";
        record.runController?.abort();
      }
      await Promise.allSettled(Array.from(records.values(), (record) => record.currentRun));
    },
  };

  parentSignal.addEventListener("abort", () => void supervisor.stop(), { once: true });
  return supervisor;
};

export type DesktopAppHandle = {
  tasks: DesktopTaskSupervisor;
  bridge: Pick<DesktopBridge, "submitTask" | "getTaskStatus" | "listTasks">;
  signal: AbortSignal;
  stop: () => Promise<void>;
};

export type StartDesktopAppOptions = {
  sql?: DesktopSql;
  logger?: DesktopLogger;
  signal?: AbortSignal;
  shutdownSignals?: boolean;
};

export const startDesktopApp = async <Config extends DesktopAppConfig>(
  config: Config,
  options: StartDesktopAppOptions = {},
): Promise<DesktopAppHandle> => {
  const controller = new AbortController();
  const externalSignal = options.signal;
  const unchainExternalAbort = externalSignal ? chainAbort(externalSignal, controller) : () => {};
  const sql = options.sql ?? getSql();
  const logger = options.logger ?? createConsoleLogger(config.identifier);
  const tasks = createDesktopTaskSupervisor({ app: config, sql, logger, signal: controller.signal });
  const ctx: DesktopLifecycleContext = { app: config, desktop, sql, logger, signal: controller.signal, tasks };
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    try {
      await config.lifecycle?.stop?.(ctx);
    } finally {
      await tasks.stop();
      unchainExternalAbort();
    }
  };

  if (options.shutdownSignals ?? true) {
    const runtimeProcess = typeof process !== "undefined" ? process : null;
    if (runtimeProcess?.on) {
      const shutdown = () => {
        void stop().then(() => runtimeProcess.exit(0));
      };
      runtimeProcess.on("SIGTERM", shutdown);
      runtimeProcess.on("SIGINT", shutdown);
    }
  }

  await config.lifecycle?.setup?.(ctx);
  await config.lifecycle?.start?.(ctx);

  return { tasks, bridge: createDesktopTaskBridge(tasks), signal: controller.signal, stop };
};

export const createDesktopTaskBridge = (
  tasks: DesktopTaskSupervisor,
): Pick<DesktopBridge, "submitTask" | "getTaskStatus" | "listTasks"> => ({
  submitTask: (id) => result(() => tasks.submit(id)),
  getTaskStatus: (id) => result(() => tasks.status(id)),
  listTasks: () => result(() => tasks.list()),
});

export const defineDesktopApp = <Config extends DesktopAppConfig>(config: Config): Config => config;

export const installDesktopBridge = (nextBridge: DesktopBridge | null): void => {
  bridgeOverride = nextBridge;
  if (hasWindow()) window.cloudDesktopRuntime = nextBridge ?? undefined;
};

export const desktop = {
  get env(): DesktopEnvironment {
    return hasWindow() ? (window.cloudDesktopEnvironment ?? browserEnvironment) : browserEnvironment;
  },

  get sql(): DesktopSql {
    return getSql();
  },

  navigate: (href: string, options: { replace?: boolean } = {}): void => {
    if (!hasWindow()) return;
    if (options.replace) window.history.replaceState(null, "", href);
    else window.history.pushState(null, "", href);
    emitNavigation();
  },

  back: (): void => {
    if (hasWindow()) window.history.back();
  },

  forward: (): void => {
    if (hasWindow()) window.history.forward();
  },

  environment: {
    get: async (): Promise<DesktopEnvironment> => {
      const result = await (bridge()?.getEnvironment?.() ?? Promise.resolve({ ok: true as const, data: browserEnvironment }));
      if (result.ok && hasWindow()) window.cloudDesktopEnvironment = result.data;
      if (!result.ok) throw new Error(result.error);
      return result.data;
    },
  },

  dialog: {
    openFile: (options?: DesktopFileDialogOptions): Promise<DesktopFileDialogResult> =>
      unwrap(bridge()?.openFileDialog?.(options) ?? unsupported("Native file dialogs")),
  },

  message: {
    show: (options: DesktopMessageOptions): Promise<DesktopMessageResult> =>
      unwrap(bridge()?.showMessage?.(options) ?? unsupported("Native message boxes")),
    info: (message: string, options: Omit<DesktopMessageOptions, "message" | "type"> = {}): Promise<DesktopMessageResult> =>
      desktop.message.show({ ...options, message, type: "info" }),
    warning: (message: string, options: Omit<DesktopMessageOptions, "message" | "type"> = {}): Promise<DesktopMessageResult> =>
      desktop.message.show({ ...options, message, type: "warning" }),
    error: (message: string, options: Omit<DesktopMessageOptions, "message" | "type"> = {}): Promise<DesktopMessageResult> =>
      desktop.message.show({ ...options, message, type: "error" }),
  },

  notification: {
    show: (options: DesktopNotificationOptions): Promise<void> =>
      unwrap(bridge()?.showNotification?.(options) ?? unsupported("Native notifications")),
  },

  clipboard: {
    writeText: (value: string): Promise<void> => unwrap(bridge()?.clipboardWriteText?.(value) ?? unsupported("Native clipboard access")),
    readText: (): Promise<string> => unwrap(bridge()?.clipboardReadText?.() ?? unsupported("Native clipboard access")),
  },

  contextMenu: {
    show: (items: DesktopContextMenuItem[]): Promise<void> =>
      unwrap(bridge()?.showContextMenu?.(items) ?? unsupported("Native context menus")),
  },

  external: {
    open: (url: string): Promise<boolean> => unwrap(bridge()?.openExternal?.(url) ?? unsupported("Native external URL opening")),
  },

  window: {
    close: (): Promise<void> => unwrap(bridge()?.closeWindow?.() ?? unsupported("Native window controls")),
    minimize: (): Promise<void> => unwrap(bridge()?.minimizeWindow?.() ?? unsupported("Native window controls")),
    maximize: (): Promise<void> => unwrap(bridge()?.maximizeWindow?.() ?? unsupported("Native window controls")),
    current: async (): Promise<DesktopWindowDescriptor | null> => {
      const fromUrl = readDesktopWindowDescriptor();
      if (fromUrl) return fromUrl;
      return unwrap(bridge()?.getCurrentWindowDescriptor?.() ?? Promise.resolve({ ok: true as const, data: null }));
    },
    open: async (view: unknown, options: DesktopWindowOpenOptions = {}): Promise<DesktopWindowRef> => {
      if (!isDesktopWindowDescriptor(view)) throw new Error("desktop.window.open expects a desktop window component.");
      const nativeOpen = bridge()?.openWindow;
      if (nativeOpen) return windowRef(await unwrap(nativeOpen({ descriptor: view, options })));
      if (!hasWindow()) return windowRef(await unwrap(unsupported<DesktopWindowRefData>("Native windows")));
      const child = window.open(descriptorUrl(view), "_blank", `popup,width=${options.width ?? 900},height=${options.height ?? 720}`);
      if (!child) throw new Error("The browser blocked the new window.");
      return windowRef({ id: "browser" }, child);
    },
  },

  tasks: {
    submit: (id: string): Promise<DesktopTaskStatus> => unwrap(bridge()?.submitTask?.(id) ?? unsupported("Desktop background tasks")),
    status: (id: string): Promise<DesktopTaskStatus | null> =>
      unwrap(bridge()?.getTaskStatus?.(id) ?? unsupported("Desktop background tasks")),
    list: (): Promise<DesktopTaskStatus[]> => unwrap(bridge()?.listTasks?.() ?? unsupported("Desktop background tasks")),
  },
};

declare global {
  interface Window {
    cloudDesktopRuntime?: DesktopBridge;
    cloudDesktopEnvironment?: DesktopEnvironment;
  }
}

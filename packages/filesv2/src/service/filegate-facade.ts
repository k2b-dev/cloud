import { Filegate, type RootClient } from "@k2b/filegate";
import { filegateMutation, type Mutation } from "./activity";

/** Tree operations walk whole roots; upload commits copy all received bytes. */
const SLOW_CALL_TIMEOUT_MS = 10 * 60 * 1000;
export function filegateCallTimeoutMs(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): number {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const slow =
    method === "DELETE" ||
    url.pathname.endsWith("/transfers") ||
    (method === "POST" && /\/uploads\/sessions\/[^/]+\/commit$/.test(url.pathname));
  return slow ? SLOW_CALL_TIMEOUT_MS : 10_000;
}

export function filegateApiFetch(transport: typeof fetch = fetch): typeof fetch {
  return Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (init?.signal) return transport(input, init);
      const budget = filegateCallTimeoutMs(input, init);
      // Bun's own socket idle timer (5 min by default) would otherwise end a silent slow call first.
      return transport(input, { ...init, signal: AbortSignal.timeout(budget), timeout: budget });
    },
    { preconnect: transport.preconnect },
  );
}

export function connectFilegate(config: { url: string; token: string }, transport?: typeof fetch): FilesFilegate {
  return FilesFilegate.connect(config, transport);
}

export class FilesFilegate {
  #client: Filegate;
  private constructor(
    client: Filegate,
    public readonly serverUrl: string,
  ) {
    this.#client = client;
  }
  static connect(config: { url: string; token: string }, transport?: typeof fetch): FilesFilegate {
    return new FilesFilegate(
      new Filegate({ baseUrl: config.url, token: config.token, transferBaseUrl: config.url, fetch: filegateApiFetch(transport) }),
      config.url,
    );
  }
  as(...args: Parameters<Filegate["as"]>): FilesFilegate {
    return new FilesFilegate(this.#client.as(...args), this.serverUrl);
  }
  root(name: string): FilesRoot {
    return new FilesRoot(this.#client.root(name), this.serverUrl);
  }
  archiveLease(...args: Parameters<Filegate["archiveLease"]>) {
    return this.#client.archiveLease(...args);
  }
  downloadRaw(...args: Parameters<Filegate["downloadRaw"]>) {
    return this.#client.downloadRaw(...args);
  }
  directSession(...args: Parameters<Filegate["directSession"]>) {
    const session = this.#client.directSession(...args);
    // Segment writes cannot publish or abort a session.
    return { put: (...args: Parameters<typeof session.put>) => session.put(...args) };
  }
}

export class FilesRoot {
  #client: RootClient;
  constructor(
    client: RootClient,
    private readonly serverUrl: string,
  ) {
    this.#client = client;
  }
  get name(): string {
    return this.#client.name;
  }
  as(...args: Parameters<RootClient["as"]>): FilesRoot {
    return new FilesRoot(this.#client.as(...args), this.serverUrl);
  }
  #mutate<T>(method: Mutation, path: string, run: () => Promise<T>): Promise<T> {
    return filegateMutation(this.serverUrl, this.name, method, path, run);
  }
  info(...args: Parameters<RootClient["info"]>) {
    return this.#client.info(...args);
  }
  resolve(...args: Parameters<RootClient["resolve"]>) {
    return this.#client.resolve(...args);
  }
  stat(...args: Parameters<RootClient["stat"]>) {
    return this.#client.stat(...args);
  }
  list(...args: Parameters<RootClient["list"]>) {
    return this.#client.list(...args);
  }
  search(...args: Parameters<RootClient["search"]>) {
    return this.#client.search(...args);
  }
  getACL(...args: Parameters<RootClient["getACL"]>) {
    return this.#client.getACL(...args);
  }
  contentRaw(...args: Parameters<RootClient["contentRaw"]>) {
    return this.#client.contentRaw(...args);
  }
  directDownload(...args: Parameters<RootClient["directDownload"]>) {
    return this.#client.directDownload(...args);
  }
  directThumbnail(...args: Parameters<RootClient["directThumbnail"]>) {
    return this.#client.directThumbnail(...args);
  }
  directVersionDownload(...args: Parameters<RootClient["directVersionDownload"]>) {
    return this.#client.directVersionDownload(...args);
  }
  session(...args: Parameters<RootClient["session"]>) {
    return this.#client.session(...args);
  }
  sessionLease(...args: Parameters<RootClient["sessionLease"]>) {
    return this.#client.sessionLease(...args);
  }
  versions(...args: Parameters<RootClient["versions"]>) {
    return this.#client.versions(...args);
  }
  mkdir(...args: Parameters<RootClient["mkdir"]>) {
    return this.#mutate("mkdir", args[0], () => this.#client.mkdir(...args));
  }
  put(...args: Parameters<RootClient["put"]>) {
    return filegateMutation(this.serverUrl, this.name, "put", args[0], () => this.#client.put(...args), undefined, {
      size: args[1].size,
      options: args[2] ?? {},
    });
  }
  createSession(...args: Parameters<RootClient["createSession"]>) {
    const { idempotencyKey, expiresIn: _expires, allowAbort: _abort, ...options } = args[2] ?? {};
    return filegateMutation(this.serverUrl, this.name, "createSession", args[0], () => this.#client.createSession(...args), undefined, {
      size: args[1],
      options,
      key: idempotencyKey,
    });
  }
  commitSession(...args: Parameters<RootClient["commitSession"]>) {
    return this.#mutate("commitSession", args[0], () => this.#client.commitSession(...args));
  }
  abortSession(...args: Parameters<RootClient["abortSession"]>) {
    return this.#mutate("abortSession", args[0], () => this.#client.abortSession(...args));
  }
  transfer(...args: Parameters<RootClient["transfer"]>) {
    return filegateMutation(this.serverUrl, this.name, "transfer", args[0], () => this.#client.transfer(...args), {
      kind: "transfer",
      root: args[1],
      path: args[2],
      move: args[3]?.move ?? false,
      onConflict: args[3]?.onConflict ?? "error",
    });
  }
  restore(...args: Parameters<RootClient["restore"]>) {
    return filegateMutation(this.serverUrl, this.name, "restore", args[0], () => this.#client.restore(...args), {
      kind: "version",
      id: args[1],
    });
  }
  copyVersion(...args: Parameters<RootClient["copyVersion"]>) {
    return filegateMutation(this.serverUrl, this.name, "copyVersion", args[0], () => this.#client.copyVersion(...args), {
      kind: "version",
      id: args[1],
      target: { root: args[2], path: args[3] },
      options: args[4],
    });
  }
  updateVersion(...args: Parameters<RootClient["updateVersion"]>) {
    return filegateMutation(this.serverUrl, this.name, "updateVersion", args[0], () => this.#client.updateVersion(...args), {
      kind: "version",
      id: args[1],
      options: args[2],
    });
  }
  deleteVersion(...args: Parameters<RootClient["deleteVersion"]>) {
    return filegateMutation(this.serverUrl, this.name, "deleteVersion", args[0], () => this.#client.deleteVersion(...args), {
      kind: "version",
      id: args[1],
    });
  }
  remove(...args: Parameters<RootClient["remove"]>) {
    return filegateMutation(this.serverUrl, this.name, "remove", args[0], () => this.#client.remove(...args), {
      kind: "remove",
      recursive: args[1] ?? false,
    });
  }
  // Maintenance only: these rebuild derived metadata, without changing user data.
  refreshStats(...args: Parameters<RootClient["refreshStats"]>) {
    return this.#client.refreshStats(...args);
  }
  rebuild(...args: Parameters<RootClient["rebuild"]>) {
    return this.#client.rebuild(...args);
  }
}

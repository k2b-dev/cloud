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
  leaseTransportUrl(url: string): string {
    return this.#client.transferUrl(url);
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

export type StorageGuard = {
  check(permission: "read" | "write", path: string, session?: boolean): Promise<void>;
  target(root: string, path: string): Promise<void>;
  lease(
    kind: "download" | "upload",
    path: string,
    lease: { url: string; expires: string },
    session?: boolean,
  ): Promise<{ url: string; expires: string }>;
};

export class FilesRoot {
  #client: RootClient;
  constructor(
    client: RootClient,
    private readonly serverUrl: string,
    private readonly guard?: StorageGuard,
  ) {
    this.#client = client;
  }
  get name(): string {
    return this.#client.name;
  }
  as(...args: Parameters<RootClient["as"]>): FilesRoot {
    return new FilesRoot(this.#client.as(...args), this.serverUrl, this.guard);
  }
  guarded(guard: StorageGuard): FilesRoot {
    return new FilesRoot(this.#client, this.serverUrl, guard);
  }
  async #read<T>(path: string, run: () => Promise<T>, session = false): Promise<T> {
    await this.guard?.check("read", path, session);
    return run();
  }
  async #mutate<T>(method: Mutation, path: string, run: () => Promise<T>): Promise<T> {
    await this.guard?.check("write", path, method === "commitSession" || method === "abortSession");
    return filegateMutation(this.serverUrl, this.name, method, path, run);
  }
  info(...args: Parameters<RootClient["info"]>) {
    return this.#client.info(...args);
  }
  resolve(...args: Parameters<RootClient["resolve"]>) {
    return this.#client.resolve(...args);
  }
  stat(...args: Parameters<RootClient["stat"]>) {
    return this.#read(args[0], () => this.#client.stat(...args));
  }
  list(...args: Parameters<RootClient["list"]>) {
    return this.#read(args[0] ?? "", () => this.#client.list(...args));
  }
  search(...args: Parameters<RootClient["search"]>) {
    return this.#read(args[1]?.path ?? "", () => this.#client.search(...args));
  }
  getACL(...args: Parameters<RootClient["getACL"]>) {
    return this.#read(args[0], () => this.#client.getACL(...args));
  }
  contentRaw(...args: Parameters<RootClient["contentRaw"]>) {
    return this.#read(args[0], () => this.#client.contentRaw(...args));
  }
  async directDownload(...args: Parameters<RootClient["directDownload"]>) {
    await this.guard?.check("read", args[0]);
    const lease = await this.#client.directDownload(...args);
    return this.guard ? { ...lease, ...(await this.guard.lease("download", args[0], lease)) } : lease;
  }
  async directThumbnail(...args: Parameters<RootClient["directThumbnail"]>) {
    await this.guard?.check("read", args[0]);
    const lease = await this.#client.directThumbnail(...args);
    return this.guard ? { ...lease, ...(await this.guard.lease("download", args[0], lease)) } : lease;
  }
  async directVersionDownload(...args: Parameters<RootClient["directVersionDownload"]>) {
    await this.guard?.check("read", args[0]);
    const lease = await this.#client.directVersionDownload(...args);
    return this.guard ? { ...lease, ...(await this.guard.lease("download", args[0], lease)) } : lease;
  }
  session(...args: Parameters<RootClient["session"]>) {
    return this.#read(args[0], () => this.#client.session(...args), true);
  }
  async sessionLease(...args: Parameters<RootClient["sessionLease"]>) {
    await this.guard?.check("write", args[0], true);
    const lease = await this.#client.sessionLease(...args);
    return this.guard ? { ...lease, ...(await this.guard.lease("upload", args[0], lease, true)) } : lease;
  }
  versions(...args: Parameters<RootClient["versions"]>) {
    return this.#read(args[0], () => this.#client.versions(...args));
  }
  mkdir(...args: Parameters<RootClient["mkdir"]>) {
    return this.#mutate("mkdir", args[0], () => this.#client.mkdir(...args));
  }
  async put(...args: Parameters<RootClient["put"]>) {
    await this.guard?.check("write", args[0]);
    return filegateMutation(this.serverUrl, this.name, "put", args[0], () => this.#client.put(...args), undefined, {
      size: args[1].size,
      options: args[2] ?? {},
    });
  }
  async createSession(...args: Parameters<RootClient["createSession"]>) {
    await this.guard?.check("write", args[0]);
    const { idempotencyKey, expiresIn: _expires, allowAbort: _abort, ...options } = args[2] ?? {};
    const created = await filegateMutation(
      this.serverUrl,
      this.name,
      "createSession",
      args[0],
      () => this.#client.createSession(...args),
      undefined,
      {
        size: args[1],
        options,
        key: idempotencyKey,
      },
    );
    return this.guard && created.lease
      ? { ...created, lease: { ...created.lease, ...(await this.guard.lease("upload", args[0], created.lease)) } }
      : created;
  }
  commitSession(...args: Parameters<RootClient["commitSession"]>) {
    return this.#mutate("commitSession", args[0], () => this.#client.commitSession(...args));
  }
  abortSession(...args: Parameters<RootClient["abortSession"]>) {
    return this.#mutate("abortSession", args[0], () => this.#client.abortSession(...args));
  }
  async transfer(...args: Parameters<RootClient["transfer"]>) {
    await this.guard?.check(args[3]?.move ? "write" : "read", args[0]);
    await this.guard?.target(args[1], args[2]);
    return filegateMutation(this.serverUrl, this.name, "transfer", args[0], () => this.#client.transfer(...args), {
      root: args[1],
      path: args[2],
      move: args[3]?.move ?? false,
      onConflict: args[3]?.onConflict ?? "error",
    });
  }
  restore(...args: Parameters<RootClient["restore"]>) {
    return this.#mutate("restore", args[0], () => this.#client.restore(...args));
  }
  async copyVersion(...args: Parameters<RootClient["copyVersion"]>) {
    await this.guard?.check("read", args[0]);
    await this.guard?.target(args[2], args[3]);
    return filegateMutation(this.serverUrl, this.name, "copyVersion", args[0], () => this.#client.copyVersion(...args));
  }
  updateVersion(...args: Parameters<RootClient["updateVersion"]>) {
    return this.#mutate("updateVersion", args[0], () => this.#client.updateVersion(...args));
  }
  deleteVersion(...args: Parameters<RootClient["deleteVersion"]>) {
    return this.#mutate("deleteVersion", args[0], () => this.#client.deleteVersion(...args));
  }
  remove(...args: Parameters<RootClient["remove"]>) {
    return this.#mutate("remove", args[0], () => this.#client.remove(...args));
  }
  // Maintenance only: these rebuild derived metadata, without changing user data.
  refreshStats(...args: Parameters<RootClient["refreshStats"]>) {
    return this.#client.refreshStats(...args);
  }
  rebuild(...args: Parameters<RootClient["rebuild"]>) {
    return this.#client.rebuild(...args);
  }
}

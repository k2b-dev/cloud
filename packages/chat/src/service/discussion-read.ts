import { type CapabilityCaller, type DiscussionProvider, discussionProviders } from "@k2b/cloud/capabilities/server";
import type { ChatContext } from "./access";

// The platform calendar reader's interactive budget, shared by discovery, lists and readers.
export const DISCUSSION_CALL_LIMIT = 60;
export const DISCUSSION_BYTE_LIMIT = 4 * 1024 * 1024;
export const DISCUSSION_CONCURRENCY = 6;
export const DISCUSSION_DEADLINE_MS = 10_000;
export class DiscussionReadStopped extends Error {}
export class DiscussionRead {
  remaining = DISCUSSION_CALL_LIMIT;
  private bytes = 0;
  readonly deadline = Date.now() + DISCUSSION_DEADLINE_MS;
  private providers?: Promise<DiscussionProvider[]>;
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private async acquire(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.active < DISCUSSION_CONCURRENCY) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal.removeEventListener("abort", abort);
        this.active++;
        resolve();
      };
      const abort = () => {
        const index = this.waiting.indexOf(start);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal.reason);
      };
      this.waiting.push(start);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  private release() {
    this.active--;
    this.waiting.shift()?.();
  }
  constructor(readonly caller: CapabilityCaller) {}
  async page<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.caller.signal?.throwIfAborted();
    if (this.remaining <= 0) throw new DiscussionReadStopped("DISCUSSION_CALL_BUDGET");
    if (this.bytes >= DISCUSSION_BYTE_LIMIT) throw new DiscussionReadStopped("DISCUSSION_BYTE_BUDGET");
    if (Date.now() >= this.deadline) throw new DiscussionReadStopped("DISCUSSION_DEADLINE");
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...(this.caller.signal ? [this.caller.signal] : [])]);
    const timer = setTimeout(() => controller.abort(new DiscussionReadStopped("DISCUSSION_DEADLINE")), this.deadline - Date.now());
    let abort: (() => void) | undefined;
    let acquired = false;
    try {
      await this.acquire(signal);
      acquired = true;
      signal.throwIfAborted();
      if (this.remaining <= 0) throw new DiscussionReadStopped("DISCUSSION_CALL_BUDGET");
      if (this.bytes >= DISCUSSION_BYTE_LIMIT) throw new DiscussionReadStopped("DISCUSSION_BYTE_BUDGET");
      this.remaining--;
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      });
      const result = await Promise.race([read(signal), cancelled]);
      signal.throwIfAborted();
      // Capability transport already bounds each individual envelope before parsing.
      this.bytes += new TextEncoder().encode(JSON.stringify(result)).byteLength;
      if (this.bytes > DISCUSSION_BYTE_LIMIT) throw new DiscussionReadStopped("DISCUSSION_BYTE_BUDGET");
      return result;
    } finally {
      clearTimeout(timer);
      if (abort) signal.removeEventListener("abort", abort);
      controller.abort();
      if (acquired) this.release();
    }
  }
  catalog() {
    this.providers ??= discussionProviderDependencies.discover(this.caller, {
      deadline: this.deadline,
      page: (read) => this.page(() => read()),
    });
    return this.providers;
  }
}
export const discussionProviderDependencies = { discover: discussionProviders };
// The caller is request-local and survives context spreads into nested Chat services.
const sessions = new WeakMap<CapabilityCaller, DiscussionRead>();
export const discussionRead = (context: ChatContext) => {
  if (!context.caller) throw new Error("DISCUSSION_CALLER_REQUIRED");
  let session = sessions.get(context.caller);
  if (!session) {
    session = new DiscussionRead(context.caller);
    sessions.set(context.caller, session);
  }
  return session;
};
export const providerFor = async (context: ChatContext, type: string, role?: "item" | "container") =>
  (await discussionRead(context).catalog()).find(
    (provider) => (role !== "container" && provider.itemType === type) || (role !== "item" && provider.containerType === type),
  );
export const typePresentation = (provider: DiscussionProvider, type: string) => {
  const entry = provider.app.manifest.types.find((entry) => `${provider.app.appId}.${entry.localId}` === type);
  return {
    typeTitle: entry?.title ?? provider.app.appName,
    icon: entry?.icon ?? provider.app.appIcon,
    ...(entry?.color ? { color: entry.color } : {}),
  };
};

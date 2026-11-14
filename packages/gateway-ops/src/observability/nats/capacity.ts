import type { NatsStream } from "./service";

/** These non-expiring fences accumulate; leave time to expand before transitions fail. */
export const lifecycleStorageWarning = (stream: NatsStream): boolean =>
  Boolean(stream.sharedTextLifecycle && stream.maxBytes > 0 && stream.bytes >= stream.maxBytes * 0.8);

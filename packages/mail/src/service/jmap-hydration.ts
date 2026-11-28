import { PassThrough, Readable } from "node:stream";
import { downloadJmapEmailSource } from "./connectors/jmap";
import type { JmapSession } from "./connectors/jmap-client";
import { JmapHttpError } from "./connectors/jmap-http";
import { type JmapTransportDependencies, JmapTransportError } from "./connectors/jmap-transport";
import { MAX_IMAP_LITERAL_BYTES } from "./connectors/source-limits";
import { classifyJmapFailure } from "./jmap-failure";
import type { MailboxTransportFence } from "./mailbox-transport-fence";
import { hydrateMessageFromSource, JMAP_HYDRATION_INTERRUPTED } from "./message-hydration";

type HydrationResult = Awaited<ReturnType<typeof hydrateMessageFromSource>>;

const interrupted = (): Error => Object.assign(new Error("JMAP body download was interrupted"), { code: JMAP_HYDRATION_INTERRUPTED });

/**
 * What a failed download of one Email's source means before the parser had it:
 * - `missing`: the provider has no source for the Email; it counts like a missing IMAP source and
 *   asks for an account delta;
 * - `rate_limited`: the batch ends without an attempt and runs again after the wait;
 * - `stop`: the batch ends without an attempt and runs again later: an authentication, network,
 *   timeout, abort or Session change failure concerns the account, not this message;
 * - `attempt`: the message uses one attempt, so a message the provider always refuses cannot hold
 *   back the mailbox. A server failure (5xx) also ends the batch, so its storage costs at most one
 *   message an attempt per run; a refusal (403, another 4xx, a redirect, a bad template, a response
 *   too large) lets the batch go on with the next message.
 */
export type JmapSourceFailure =
  | { kind: "missing" }
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "stop" }
  | { kind: "attempt"; endsBatch: boolean };

export function classifyJmapSourceFailure(error: unknown, now: number): JmapSourceFailure {
  if (error instanceof JmapTransportError && error.code === "JMAP_SOURCE_MISSING") return { kind: "missing" };
  const failure = classifyJmapFailure(error, now);
  if (failure?.kind === "rate_limited") return failure;
  if (failure?.kind === "access_denied" || failure?.kind === "invalid") return { kind: "attempt", endsBatch: false };
  if (failure?.kind === "unavailable" && error instanceof JmapHttpError) return { kind: "attempt", endsBatch: true };
  return { kind: "stop" };
}

/**
 * Whether a failure the parser recorded as an attempt ends the batch: a server failure, or a
 * connection that broke off or went idle while the source streamed. The batch then reports it, so
 * the provider's timeout breaker sees it as for IMAP. A broken message (bad MIME) does not.
 */
export function endsJmapBatch(error: unknown): boolean {
  if (error instanceof JmapHttpError) return error.status >= 500;
  return error instanceof JmapTransportError && (error.code === "JMAP_TRANSPORT" || error.code === "JMAP_TIMEOUT");
}

// A source that fails with the download's own error once the parser reads it, so the parser takes
// its claim and records the attempt with that error's code, the one place that counts attempts.
const failingSource = (error: unknown): Readable =>
  new Readable({
    read() {
      this.destroy(error instanceof Error ? error : new Error("JMAP body download failed"));
    },
  });

/**
 * The source the parser reads, with one change: once `signal` stopped the download, every stream
 * error and the parser's own cancellation carry `JMAP_HYDRATION_INTERRUPTED`. A failure while the
 * download runs on, such as a broken connection, keeps its own error and counts an attempt.
 */
export function interruptibleJmapSource(source: Readable, signal: AbortSignal): { source: Readable; signal: AbortSignal; close(): void } {
  const body = new PassThrough();
  // The parser reads an early error from the destroyed stream; this keeps it from being unhandled
  // while the parser still waits for its claim.
  body.on("error", () => undefined);
  const parser = new AbortController();
  const stop = () => parser.abort(interrupted());
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  source.on("error", (error) => body.destroy(signal.aborted ? interrupted() : error));
  source.pipe(body);
  return { source: body, signal: parser.signal, close: () => signal.removeEventListener("abort", stop) };
}

/**
 * How one JMAP source ended:
 * - `hydrated`: the parser stored it (or found it stored or merged);
 * - `failed`: the parser had the source and recorded the failure as an attempt, or restored its
 *   claim for an interruption or a changed transport; a download failure that counts an attempt
 *   (see `classifyJmapSourceFailure`) also ends here, with the download's error;
 * - `unread`: the source never reached the parser, so no claim exists.
 */
export type JmapSourceOutcome =
  | { kind: "hydrated"; result: HydrationResult }
  | { kind: "failed"; error: unknown }
  | { kind: "unread"; error: unknown };

/**
 * Streams one Email's source into the unchanged parser. The blob ID comes from the caller's batch
 * and is never stored. A source above the download budget is not downloaded; the parser records
 * the message as too large from its stored size.
 */
export async function hydrateJmapSource(params: {
  session: JmapSession;
  authorization: string;
  accountId: string;
  messageId: string;
  blobId: string;
  /** The Email's `size`, the expected source length. */
  size: number;
  /** The message's stored size, which the parser checks against the download budget. */
  sizeBytes: number;
  claimId: string;
  transportFence: MailboxTransportFence;
  signal: AbortSignal;
  transport?: JmapTransportDependencies;
}): Promise<JmapSourceOutcome> {
  const started: { hydration?: Promise<HydrationResult> } = {};
  const hydrate = (source: Readable): Promise<HydrationResult> => {
    const guarded = interruptibleJmapSource(source, params.signal);
    started.hydration = hydrateMessageFromSource({
      messageId: params.messageId,
      source: guarded.source,
      expectedSize: params.size,
      signal: guarded.signal,
      claimId: params.claimId,
      transportFence: params.transportFence,
    }).finally(guarded.close);
    return started.hydration;
  };
  try {
    const result =
      params.sizeBytes > MAX_IMAP_LITERAL_BYTES
        ? await hydrate(Readable.from([]))
        : await downloadJmapEmailSource(
            params.session,
            params.authorization,
            params.accountId,
            params.blobId,
            params.size,
            hydrate,
            params.signal,
            params.transport,
          );
    return { kind: "hydrated", result };
  } catch (error) {
    // Once the parser has the source, its outcome counts, even when the download failed first.
    if (!started.hydration) {
      if (classifyJmapSourceFailure(error, Date.now()).kind !== "attempt") return { kind: "unread", error };
      // Read lazily, after the parser listens: it records exactly this error.
      started.hydration = hydrateMessageFromSource({
        messageId: params.messageId,
        source: failingSource(error),
        expectedSize: params.size,
        claimId: params.claimId,
        transportFence: params.transportFence,
      });
    }
    const hydration = started.hydration;
    if (!hydration) return { kind: "unread", error };
    return hydration.then(
      (result): JmapSourceOutcome => ({ kind: "hydrated", result }),
      (failure: unknown): JmapSourceOutcome => ({ kind: "failed", error: failure }),
    );
  }
}

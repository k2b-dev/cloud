import { PassThrough, Readable } from "node:stream";
import { downloadJmapEmailSource } from "./connectors/jmap";
import type { JmapSession } from "./connectors/jmap-client";
import { type JmapTransportDependencies, JmapTransportError } from "./connectors/jmap-transport";
import { MAX_IMAP_LITERAL_BYTES } from "./connectors/source-limits";
import { classifyJmapFailure } from "./jmap-failure";
import type { MailboxTransportFence } from "./mailbox-transport-fence";
import { hydrateMessageFromSource, JMAP_HYDRATION_INTERRUPTED } from "./message-hydration";

type HydrationResult = Awaited<ReturnType<typeof hydrateMessageFromSource>>;

const interrupted = (): Error => Object.assign(new Error("JMAP body download was interrupted"), { code: JMAP_HYDRATION_INTERRUPTED });

/**
 * What a failed download that never reached the parser means for its body. No claim exists yet,
 * so only a missing source counts an attempt:
 * - `missing`: the provider has no source for the Email; it counts like a missing IMAP source and
 *   asks for an account delta;
 * - `rate_limited`: the batch ends and runs again after the wait;
 * - `stop`: the batch ends without an attempt, for example after an authentication, network,
 *   timeout, abort or Session change failure, and runs again later.
 */
export type JmapSourceFailure = { kind: "missing" } | { kind: "rate_limited"; retryAfterMs: number } | { kind: "stop" };

export function classifyJmapSourceFailure(error: unknown, now: number): JmapSourceFailure {
  if (error instanceof JmapTransportError && error.code === "JMAP_SOURCE_MISSING") return { kind: "missing" };
  const failure = classifyJmapFailure(error, now);
  return failure?.kind === "rate_limited" ? failure : { kind: "stop" };
}

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
 *   claim for an interruption or a changed transport;
 * - `unread`: the source never reached the parser, so no claim exists (see `classifyJmapSourceFailure`).
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
    if (!started.hydration) return { kind: "unread", error };
    return started.hydration.then(
      (result): JmapSourceOutcome => ({ kind: "hydrated", result }),
      (failure: unknown): JmapSourceOutcome => ({ kind: "failed", error: failure }),
    );
  }
}

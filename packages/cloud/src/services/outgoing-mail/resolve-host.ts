import { env } from "../../config/env";
import { networkAddressFamily, normalizeNetworkHostname, parseNetworkAllowlistEnv } from "../../shared/network-address";
import { NetworkTargetBlockedError, resolveAllowedNetworkAddresses } from "../network-security";

export const outgoingMailAllowlist = () => parseNetworkAllowlistEnv("OUTGOING_MAIL_ALLOWED_TARGETS", env.OUTGOING_MAIL_ALLOWED_TARGETS);

/** One bounded lookup shared by SMTP and bounce IMAP; clients use only the checked addresses. */
export const resolveMailHost = async (host: string, signal?: AbortSignal, resolve = resolveAllowedNetworkAddresses, port?: number) => {
  const hostname = normalizeNetworkHostname(host);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("Outgoing mail DNS lookup timed out.")), 5000);
  const cancellation = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  let abort: (() => void) | undefined;
  try {
    cancellation.throwIfAborted();
    const addresses = await Promise.race([
      resolve(hostname, outgoingMailAllowlist(), undefined, port),
      new Promise<never>((_, reject) => {
        abort = () => reject(cancellation.reason);
        cancellation.addEventListener("abort", abort, { once: true });
        if (cancellation.aborted) abort();
      }),
    ]);
    return {
      host: hostname,
      addresses: [...addresses.filter((entry) => entry.family === 4), ...addresses.filter((entry) => entry.family === 6)],
      servername: networkAddressFamily(hostname) ? undefined : hostname,
    };
  } catch (error) {
    if (error instanceof NetworkTargetBlockedError)
      throw new NetworkTargetBlockedError(
        "Outgoing mail target is on an internal network. An operator can allow it with OUTGOING_MAIL_ALLOWED_TARGETS.",
      );
    throw error;
  } finally {
    clearTimeout(timer);
    if (abort) cancellation.removeEventListener("abort", abort);
  }
};

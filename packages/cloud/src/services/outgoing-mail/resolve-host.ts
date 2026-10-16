import { env } from "../../config/env";
import { networkAddressFamily, normalizeNetworkHostname, parseNetworkAllowlistEnv } from "../../shared/network-address";
import { NetworkTargetBlockedError, resolveAllowedNetworkAddresses } from "../network-security";

export const outgoingMailAllowlist = () => parseNetworkAllowlistEnv("OUTGOING_MAIL_ALLOWED_TARGETS", env.OUTGOING_MAIL_ALLOWED_TARGETS);

/** One bounded lookup shared by SMTP and bounce IMAP; clients connect to the checked IP. */
export const resolveMailHost = async (host: string, signal?: AbortSignal, resolve = resolveAllowedNetworkAddresses) => {
  const hostname = normalizeNetworkHostname(host);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("Outgoing mail DNS lookup timed out.")), 5000);
  const cancellation = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  let abort: (() => void) | undefined;
  try {
    cancellation.throwIfAborted();
    const addresses = await Promise.race([
      resolve(hostname, outgoingMailAllowlist()),
      new Promise<never>((_, reject) => {
        abort = () => reject(cancellation.reason);
        cancellation.addEventListener("abort", abort, { once: true });
        if (cancellation.aborted) abort();
      }),
    ]);
    // Nodemailer preferred IPv4 before it got a pinned literal; keep that so an AAAA-first answer on an IPv4-only host still connects.
    const target = addresses.find((entry) => entry.family === 4) ?? addresses[0]!;
    return { address: target.address, servername: networkAddressFamily(hostname) ? undefined : hostname };
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

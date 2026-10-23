import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { NetworkTargetBlockedError, type PublicNetworkAddress, resolvePublicNetworkAddresses } from "@k2b/cloud/services/network-security";
import { withNetworkDeadline } from "@k2b/cloud/services/network-transport";
import { isUnsafeNetworkHostname } from "@k2b/cloud/shared";
import type { MailEndpoint } from "../../contracts";

export type ResolvedEndpoint = MailEndpoint & {
  host: string;
  addresses: PublicNetworkAddress[];
};

export class EndpointPolicyError extends Error {
  constructor(
    message: string,
    // A lookup that timed out says nothing about the host, so it keeps its own code and can be retried.
    readonly code: "ENDPOINT_BLOCKED" | "ENDPOINT_DNS_TIMEOUT" = "ENDPOINT_BLOCKED",
  ) {
    super(message);
    this.name = "EndpointPolicyError";
  }
}

const normalizeHost = (rawHost: string): string => {
  const trimmed = rawHost.trim().replace(/\.$/, "").toLowerCase();
  if (!trimmed || trimmed.length > 253 || /[\s/@\\]/.test(trimmed)) throw new EndpointPolicyError("Invalid endpoint host");

  const unbracketed = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  if (isIP(unbracketed)) return unbracketed;
  if (unbracketed.includes(":")) throw new EndpointPolicyError("Invalid endpoint host");

  const ascii = domainToASCII(unbracketed);
  if (!ascii || ascii.length > 253) throw new EndpointPolicyError("Invalid endpoint host");
  const labels = ascii.split(".");
  if (labels.some((label) => label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new EndpointPolicyError("Invalid endpoint host");
  }

  if (isUnsafeNetworkHostname(ascii)) {
    throw new EndpointPolicyError("Endpoint host is not publicly routable");
  }
  return ascii;
};

export const resolvePublicEndpoint = async (endpoint: MailEndpoint, timeoutMs = 5_000, signal?: AbortSignal): Promise<ResolvedEndpoint> => {
  const host = normalizeHost(endpoint.host);
  try {
    const resolved = await withNetworkDeadline(
      timeoutMs,
      signal,
      new EndpointPolicyError("Endpoint DNS lookup timed out", "ENDPOINT_DNS_TIMEOUT"),
      () => resolvePublicNetworkAddresses(host),
    );
    const addresses = [...new Map(resolved.map((entry) => [entry.address, entry])).values()];
    return { ...endpoint, host, addresses };
  } catch (error) {
    if (error instanceof NetworkTargetBlockedError) throw new EndpointPolicyError("Endpoint host resolved to a non-public address");
    if (error instanceof Error && error.message === "Network target could not be resolved") {
      throw new EndpointPolicyError("Endpoint host did not resolve");
    }
    throw error;
  }
};

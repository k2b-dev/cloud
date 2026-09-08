import { appApproval, type AppApprovalDevice } from "@valentinkolb/cloud/browser/app-approval";

/** Call only after showing the parsed issuer and obtaining consent. */
export const connectTrustedPairing = async (link: string, authenticatorOrigin: string, signal?: AbortSignal) => {
  const pairing = appApproval.parsePairingLink(link, authenticatorOrigin);
  const client = await appApproval.connect({ issuer: pairing.issuer, authenticatorOrigin, signal });
  const key = await appApproval.createKey();
  // Persist this CryptoKey in IndexedDB before claiming. Reuse it for recovery;
  // never persist the pairing secret or export the private key.
  return { pairing, client, key };
};

/** Foreground polling never signs a decision as a side effect. */
export const readPendingLogins = (
  client: Awaited<ReturnType<typeof appApproval.connect>>,
  device: AppApprovalDevice,
  signal?: AbortSignal,
) => client.pending(device, signal);

import { type AppApprovalDevice, appApproval } from "@k2b/cloud/browser/app-approval";

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

/** The caller stores config + blob atomically and drops this session on lifecycle lock. */
export const createProtectedPairing = async (link: string, pin: string) => {
  const pairing = appApproval.parsePairingLink(link, location.origin);
  const session = await appApproval.vault.create();
  try {
    const method = await session.pin(pin);
    const config = appApproval.vault.parseConfig({ version: 1, id: session.id, methods: [method] });
    const checked = await appApproval.vault.unlock(config, "pin", pin);
    checked.lock();
    const context = JSON.stringify(["enrollments", pairing.issuer, pairing.pairingId]);
    const key = await session.createKey();
    const blob = await session.sealRecord({ key, issuer: pairing.issuer, pairingId: pairing.pairingId }, context);
    // Persist config and blob before claim. Never persist the link or runtime key.
    return { session, config, blob, context, key, pairing };
  } catch (error) {
    session.lock();
    throw error;
  }
};

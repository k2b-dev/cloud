import { createHash, randomUUID } from "node:crypto";
import { decryptSecret, encryptSecret } from "@k2b/cloud/services";

const createPublicDashboardTokenValue = (): string => randomUUID();

export const publicDashboardTokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");

export const encryptPublicDashboardToken = (token: string): Promise<string> => encryptSecret(token);

export const decryptPublicDashboardToken = (encryptedToken: string): Promise<string> => decryptSecret<string>(encryptedToken);

export const resolvePublicDashboardToken = async (params: {
  publicEnabled: boolean;
  encryptedToken: string | null;
}): Promise<{ token: string; encryptedToken: string; tokenHash: string }> => {
  const existingEncryptedToken = params.publicEnabled ? params.encryptedToken : null;
  const token = existingEncryptedToken ? await decryptPublicDashboardToken(existingEncryptedToken) : createPublicDashboardTokenValue();
  const encryptedToken = existingEncryptedToken ?? (await encryptPublicDashboardToken(token));
  return {
    token,
    encryptedToken,
    tokenHash: publicDashboardTokenHash(token),
  };
};

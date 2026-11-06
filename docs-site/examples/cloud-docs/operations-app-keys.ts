import { formatAppKey, parseAppKey } from "@k2b/cloud/app-key";

export function finishEnrollment(
  seed: string,
  appId: string,
  registration: { installationId: string; keyId: string; status: string; accountStatus: string },
) {
  if (registration.status !== "active" || registration.accountStatus !== "active") throw new Error("Enrollment is inactive");
  const value = formatAppKey({ ...registration, appId, seed });
  return { value, identity: parseAppKey(value) };
}

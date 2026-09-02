export type IncomingAutomationMandateCaller = {
  authorization: string;
  mandate: { id: string; revision: number; callingAppId: "mail" };
};

export const incomingAutomationMandateCaller = (
  mandate: { id: string; revision: number },
  credential = process.env.CLOUD_APP_CREDENTIAL,
): IncomingAutomationMandateCaller => {
  const token = credential?.trim();
  if (!token) {
    throw Object.assign(new Error("Mail workload authorization is unavailable"), { code: "WORKLOAD_AUTH_UNAVAILABLE" });
  }
  if (!Number.isSafeInteger(mandate.revision) || mandate.revision < 1) {
    throw Object.assign(new Error("This automation has no active Spaces authorization"), { code: "FORBIDDEN" });
  }
  return {
    authorization: `Bearer ${token}`,
    mandate: { id: mandate.id, revision: mandate.revision, callingAppId: "mail" },
  };
};

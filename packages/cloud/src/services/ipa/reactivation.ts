import { num, parseGeneralizedTime, str } from "../../server/services/freeipa/util";
import { normalizeAccountEmail } from "../accounts/email-write";

export const IPA_IDENTITY_CONFLICT =
  "The existing FreeIPA account cannot be safely linked to this person. Ask an administrator to verify its identity.";
export const IPA_MISSING_CONFLICT =
  "The original FreeIPA account is missing. Restore its directory identity before approving this request.";
export const IPA_ACTIVE_CONFLICT = "The existing FreeIPA account is active. Ask an administrator to verify its identity before linking it.";

/** Remote entry IDs survive enable/expiry/password changes; a login name alone does not identify a person. */
export const ipaEntryId = (entry: Record<string, unknown>): string | null => {
  for (const key of ["ipauniqueid", "nsuniqueid"]) {
    const value = str(entry[key]).trim();
    if (value && value !== "autogenerate") return `${key}:${value}`;
  }
  return null;
};

export const reactivationConflict = (params: {
  entry: Record<string, unknown>;
  uid: string;
  mail: string;
  uidNumber: number | null;
  retry?: { directory_url: string; uid: string; mail: string; remote_id: string };
  directoryUrl: string;
  now: Date;
}): string | null => {
  const { entry, retry } = params;
  const remoteId = ipaEntryId(entry);
  const mails = Array.isArray(entry.mail) ? entry.mail : [entry.mail];
  const mailMatches = mails.some((mail) => typeof mail === "string" && normalizeAccountEmail(mail) === normalizeAccountEmail(params.mail));
  if (
    str(entry.uid) !== params.uid ||
    !mailMatches ||
    !remoteId ||
    (params.uidNumber !== null && num(entry.uidnumber) !== params.uidNumber) ||
    (retry &&
      (retry.remote_id !== remoteId ||
        retry.directory_url !== params.directoryUrl ||
        retry.uid !== params.uid ||
        normalizeAccountEmail(retry.mail) !== normalizeAccountEmail(params.mail)))
  )
    return IPA_IDENTITY_CONFLICT;
  const expires = parseGeneralizedTime(entry.krbprincipalexpiration);
  const disabled = str(entry.nsaccountlock).toLowerCase() === "true";
  if (!retry && !disabled && !(expires && expires <= params.now)) return IPA_ACTIVE_CONFLICT;
  return null;
};

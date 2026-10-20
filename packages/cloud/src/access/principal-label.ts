import type { Principal, ServiceAccountKind } from "../contracts/shared";
import { groupDisplayName } from "../shared/account-display";
import { accessMessages } from "./messages";

/** A human label, never an identity. Resolve names only after authorizing the resource operation. */
export const principalLabel = (
  entry: { principal: Principal; displayName?: string | null; serviceAccountKind?: ServiceAccountKind },
  locale: string | null | undefined,
): string => {
  const { t } = accessMessages.resolve([locale ?? "en"]);
  const { principal, displayName } = entry;
  if (principal.type === "authenticated") return t.allUsers;
  if (principal.type === "public") return t.public;
  if (displayName) return principal.type === "group" ? groupDisplayName(displayName, locale) : displayName;
  if (principal.type === "user") return t.unknownPerson;
  if (principal.type === "group") return t.deletedGroup;
  return entry.serviceAccountKind === "agent" ? t.unknownAgent : t.unknownServiceAccount;
};

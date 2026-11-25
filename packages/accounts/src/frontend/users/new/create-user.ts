import type { AccountCategory, AccountCategoryPolicy } from "@k2b/cloud/contracts";

/** An open account request the new account completes; the page shows it and fills the form from it. */
export type AccountRequestView = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  displayName: string | null;
  phone: string | null;
  comment: string | null;
};

/** What the form holds; the payload is built from it only when it is sent. */
export type CreateUserForm = {
  category: AccountCategory | undefined;
  givenname: string;
  sn: string;
  email: string;
  displayName: string;
  admin: boolean;
  welcome: boolean;
};

export type CreateUserPayload =
  | {
      provider: "ipa";
      email: string;
      givenname: string;
      sn: string;
      displayName?: string;
      autoSendNotification: boolean;
      requestId?: string;
    }
  | {
      provider: "local";
      profile: "user" | "guest";
      admin?: boolean;
      email?: string;
      givenname: string;
      sn: string;
      displayName?: string;
      autoSendNotification: boolean;
      requestId?: string;
    };

/** The account types this person may create here: allowed by the policy, FreeIPA only while on, a request only in FreeIPA. */
export const allowedCategories = (policy: AccountCategoryPolicy, freeIpaEnabled: boolean, fromRequest: boolean): AccountCategory[] =>
  (["freeipa", "login", "guest"] as const).filter(
    (category) => policy[category].enabled && (category !== "freeipa" || freeIpaEnabled) && (!fromRequest || category === "freeipa"),
  );

/** Only full Login accounts may lack an email, while the installation allows it; guests, FreeIPA and requests keep it. */
export const emailOptional = (form: Pick<CreateUserForm, "category">, localEmailOptional: boolean, fromRequest: boolean) =>
  localEmailOptional && form.category === "login" && !fromRequest;

/** What is missing before the form may be sent, as message keys by field. */
export const missingFields = (form: CreateUserForm, optionalEmail: boolean) => ({
  category: !form.category,
  email: !form.email.trim() && !optionalEmail,
  givenname: !form.givenname.trim(),
  sn: !form.sn.trim(),
});

/**
 * The request the form sends. A FreeIPA account has no profile; a local one is a guest or a full account, which may be
 * an administrator. Without an email no welcome mail can go out.
 */
export const createUserPayload = (form: CreateUserForm & { category: AccountCategory }, requestId?: string): CreateUserPayload => {
  const person = {
    givenname: form.givenname.trim(),
    sn: form.sn.trim(),
    displayName: form.displayName.trim() || undefined,
    requestId,
  };
  if (form.category === "freeipa") return { provider: "ipa", email: form.email.trim(), ...person, autoSendNotification: form.welcome };
  const profile = form.category === "guest" ? "guest" : "user";
  const email = form.email.trim() || undefined;
  return {
    provider: "local",
    profile,
    admin: profile === "user" ? form.admin : false,
    email,
    ...person,
    autoSendNotification: form.welcome && email !== undefined,
  };
};

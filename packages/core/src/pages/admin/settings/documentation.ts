/** Article paths are independent of the deployment's documentation website. */
export const settingsDocumentation: Readonly<Record<string, string>> = {
  general: "accounts/documentation",
  user: "operations/account-categories",
  registration: "accounts/registration",
  freeipa: "operations/freeipa",
  linux: "operations/linux-identities",
  "account-operations": "accounts/lifecycle",
  "app.identity": "accounts/documentation",
  "user.login": "operations/account-categories",
  "user.registration": "accounts/registration",
  "user.actionNotice": "accounts/change-notices",
  "user.appApproval": "accounts/app-sign-in",
  "user.expiry": "accounts/lifecycle#account-expiry",
  "user.reminders": "accounts/lifecycle#reminders-and-cleanup",
  "freeipa.connection": "operations/freeipa#configure-the-connection",
  "freeipa.service": "operations/freeipa#grant-service-account-permissions",
  "freeipa.groups": "operations/freeipa#define-group-scope",
  "freeipa.sync": "operations/freeipa#account-matching-and-transitions",
};

export function settingsDocumentationHref(base: string | undefined, topic: string): string | undefined {
  const path = settingsDocumentation[topic];
  if (!base || !path) return undefined;
  try {
    const url = new URL(base);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    // English is the documentation site's only published locale. Preserve mirrors' path prefixes.
    return new URL(`en/docs/${path}`, `${url.href.replace(/\/+$/, "")}/`).href;
  } catch {
    return undefined;
  }
}

import { apiClient } from "@k2b/cloud/clients/core";

export type SignOutOthersOutcome = "signed-out" | "sign-in-again" | "failed";

/** Ends the person's other sign-ins once more after a password change. Retrying "failed" is safe: the step repeats. */
export const retrySignOutOthers = async (): Promise<SignOutOthersOutcome> => {
  const res = await apiClient.me["sign-ins"]["sign-out-others"].$post({}).catch(() => null);
  // A lost answer to an earlier retry can end this browser's sign-in too; only signing in again helps then.
  // Without a browser sign-in, a request can fall back to a mobile app session, which the route refuses with 403.
  // The route's typed answers omit the 401 its auth middleware sends.
  const status: number | undefined = res?.status;
  if (status === 401 || status === 403) return "sign-in-again";
  // An unreadable answer leaves the outcome open, like a failure.
  const body = res?.ok ? await res.json().catch(() => null) : null;
  if (!body) return "failed";
  return body.signInAgain ? "sign-in-again" : "signed-out";
};

/** The sign-in page that brings the person back to `redirectTo`. */
export const signInAgainHref = (redirectTo: string | null | undefined): string =>
  redirectTo ? `/auth/login?${new URLSearchParams({ redirectTo })}` : "/auth/login";

const RETRY_PARAM = "signOutOthers";

/** Whether a page opens at the sign-out retry, after a reload, a new sign-in or the terms confirmation. */
export const isSignOutOthersRetry = (params: URLSearchParams): boolean => params.get(RETRY_PARAM) === "retry";

/** The address without the retry, once a page has taken it over. */
export const withoutSignOutOthersRetry = (url: URL): string => {
  url.searchParams.delete(RETRY_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
};

/** This page's address at the retry. A used reset token is dropped. */
export const signOutOthersRetryPath = (href: string): string => {
  const url = new URL(href);
  url.searchParams.delete("token");
  url.searchParams.set(RETRY_PARAM, "retry");
  return `${url.pathname}${url.search}`;
};

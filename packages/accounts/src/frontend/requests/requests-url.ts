/** The views of the request list and their addresses, read by the SSR page and written by the screen. */
export const REQUESTS_PATH = "/app/accounts/requests";
export const REQUEST_STATUSES = ["pending", "completed", "denied", "all"] as const;
export type RequestStatusView = (typeof REQUEST_STATUSES)[number];
/** Requests per page, as before v2. */
export const REQUESTS_PER_PAGE = 100;

/** The view an address names; "pending" when it names none or an unknown one. */
export const parseRequestStatus = (value: string | undefined): RequestStatusView =>
  REQUEST_STATUSES.find((status) => status === value) ?? "pending";

/** A positive page number, or 1. */
export const parseRequestsPage = (value: string | undefined): number => {
  const parsed = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

/** The address of a view and page: "pending" and page 1 are the defaults and leave the address. */
export const requestsHref = (status: RequestStatusView, page = 1): string => {
  const params = new URLSearchParams();
  if (status !== "pending") params.set("status", status);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `${REQUESTS_PATH}?${query}` : REQUESTS_PATH;
};

/** The page of one pending request: the new-user form filled from it, with "deny" beside it. */
export const requestHref = (id: string): string => `/app/accounts/users/new?${new URLSearchParams({ request: id })}`;

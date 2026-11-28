/**
 * The feedback list's one declaration: the window in days, only entries with a comment, and the search over comments.
 * The SSR page reads and the browser writes the address only through it; Venue filters on the server
 * (`venueService.dashboard`). There are no saved views.
 */
import { defineListQuery, field, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import { venueMessages } from "../messages";

export const FEEDBACK_DAYS = [7, 14, 30] as const;
export type FeedbackDays = (typeof FEEDBACK_DAYS)[number];
/** Longest search over comments; a longer text is dropped, never cut silently. */
export const FEEDBACK_SEARCH_MAX = 200;

export const feedbackQuery = (locale: string) => {
  const { t } = venueMessages.resolve([locale]);
  return defineListQuery({
    key: "venue.feedback",
    fields: {
      days: field.choice({
        label: t.feedbackWindow,
        common: true,
        multiple: false,
        options: FEEDBACK_DAYS.map((count) => ({ value: String(count), label: t.lastDays({ count }) })),
        required: "30",
      }),
      comments: field.choice({
        label: t.comments,
        common: true,
        multiple: false,
        options: [{ value: "1", label: t.onlyWithComment }],
      }),
    },
    search: { label: t.searchFeedbackComments },
    sort: { fixed: { field: "createdAt", direction: "desc", label: t.newestFirst } },
    pageParams: ["page"],
  });
};

export type FeedbackQuery = ReturnType<typeof feedbackQuery>;
export type FeedbackState = ListQueryStateOf<FeedbackQuery>;

/** What the server asks the dashboard for, read from the address through the declaration. Never throws. */
export const parseFeedbackAddress = (query: FeedbackQuery, params: URLSearchParams) => {
  const { state } = query.parse(params);
  const days = FEEDBACK_DAYS.find((count) => String(count) === state.filters.days?.[0]) ?? 30;
  const search = (state.search ?? "").trim();
  const page = Number(params.get("page"));
  return {
    state,
    days,
    comments: state.filters.comments?.[0] === "1",
    search: search.length <= FEEDBACK_SEARCH_MAX ? search : "",
    page: Number.isSafeInteger(page) && page > 1 ? page : 1,
  };
};

/** Addresses from before v2 named the search `search=`; they lead to the same list with `q=`. */
export const legacyFeedbackHref = (path: string, params: URLSearchParams): string | null => {
  if (!params.has("search")) return null;
  const next = new URLSearchParams(params);
  const search = next.get("search") ?? "";
  next.delete("search");
  if (search.trim()) next.set("q", search.trim());
  return `${path}${next.size ? `?${next}` : ""}`;
};

/** The address of the feedback list for a state, on page 1 unless a page is given. */
export const feedbackHref = (venueId: string, query: FeedbackQuery, state: FeedbackState, page = 1) => {
  const params = query.serialize(state);
  if (page > 1) params.set("page", String(page));
  return `/app/venue/${encodeURIComponent(venueId)}/feedback${params.size ? `?${params}` : ""}`;
};

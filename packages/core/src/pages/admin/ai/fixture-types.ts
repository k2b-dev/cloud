/**
 * The contract between the AI area's browser fixture and its section fixtures: each section module builds the props of
 * its screen (without the admin bar) from the address and answers its own API requests. Invented data only.
 */
export type AiFixtureInput = {
  /** `?state=`: normal, worst, empty and the section's own states. */
  state: string;
  /** The page's address without `locale` and `state`. */
  params: URLSearchParams;
  locale: "de" | "en";
};

/** One API request the page sent, as the tests read it. */
export type AiFixtureRequest = { method: string; path: string; body: unknown };

export type AiFixtureApi = (request: Request, url: URL, state: string) => Promise<Response | undefined> | Response | undefined;

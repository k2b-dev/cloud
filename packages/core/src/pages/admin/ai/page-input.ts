import type { User } from "@k2b/cloud/contracts";
import type { getDateConfig } from "@k2b/cloud/server";

/**
 * What a section's server loader of the AI area reads from the request, handed over by the page: the loaders stay
 * plain functions of data, and the page alone renders the layout around their screen.
 */
export type AiPageInput = {
  locale: string;
  /** The address's query parameters, as Hono reads them. */
  query: Record<string, string>;
  /** The request's whole address. */
  url: string;
  user: User;
  /** The names of the running apps by id, for app skills, usage rows and class users. */
  appNames: Record<string, string>;
  /** The Cloud has the dedicated page of background jobs. */
  showAiJobsLink: boolean;
  /** The viewer's time zone and the request's locale, for times the server words. */
  dates: ReturnType<typeof getDateConfig>;
};

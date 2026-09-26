/** Pure URL classification shared by the server preview resolver and the browser. */

export type GitHubLinkTarget = { owner: string; repo: string; number: number };

const GITHUB_URL =
  /^https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})\/(issues|pull)\/(\d{1,9})(?:[/?#].*)?$/;

/** The GitHub issue or pull request a URL points at, or null for every other URL. */
export const parseGitHubLink = (url: string): GitHubLinkTarget | null => {
  const match = GITHUB_URL.exec(url);
  if (!match) return null;
  const number = Number(match[4]);
  if (number < 1) return null;
  return { owner: match[1]!, repo: match[2]!, number };
};

/** Hostname without a leading `www.`, or the raw value when it is not a URL. */
export const linkHostname = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

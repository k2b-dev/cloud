import { ratelimit } from "@k2b/cloud/server";
import { logger } from "@k2b/cloud/services";
import { redis } from "bun";
import { z } from "zod";
import type { SpaceItemLink, SpaceItemLinkPreview } from "@/contracts";
import { type GitHubLinkTarget, parseGitHubLink } from "@/lib/link-targets";

export { parseGitHubLink };

/**
 * Display-only previews for external item links. GitHub issue and pull
 * request URLs are resolved through the public REST API, everything else
 * renders from the URL alone. Results live in Valkey for a short time so a
 * detail view never repeats a fetch and SSR only ever reads the cache.
 */

const log = logger("spaces:link-previews");

const GITHUB_API = "https://api.github.com";
const FETCH_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const PREVIEW_TTL_SECONDS = 300;
const MISSING_TTL_SECONDS = 60;
const LIMITED_TTL_SECONDS = 300;
const MISSING = "!missing";
/** Outbound GitHub calls per Space and minute; a full detail view needs at most `MAX_ITEM_LINKS`. */
const FETCH_BUDGET_PER_MINUTE = 30;

const GitHubIssueSchema = z.object({
  title: z.string(),
  state: z.enum(["open", "closed"]),
  pull_request: z.object({ merged_at: z.string().nullable().optional() }).optional(),
});

export type GitHubPreviewResult =
  | { status: "ok"; preview: SpaceItemLinkPreview }
  | { status: "missing" }
  | { status: "limited" }
  | { status: "error" };

const readBounded = async (response: Response): Promise<string | null> => {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
};

/** One bounded GitHub API call; the token is optional and only widens what is visible. */
export const fetchGitHubPreview = async (
  target: GitHubLinkTarget,
  options: { token?: string | null; fetch?: typeof fetch } = {},
): Promise<GitHubPreviewResult> => {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "cloud-spaces-link-preview",
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const url = `${GITHUB_API}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues/${target.number}`;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "manual" });
  } catch (error) {
    log.warn("GitHub preview fetch failed", {
      repo: `${target.owner}/${target.repo}`,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "error" };
  }
  if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) {
    await response.body?.cancel();
    return { status: "limited" };
  }
  if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 410) {
    await response.body?.cancel();
    return { status: "missing" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { status: "error" };
  }
  const body = await readBounded(response);
  if (body === null) return { status: "error" };
  let parsed: z.infer<typeof GitHubIssueSchema>;
  try {
    parsed = GitHubIssueSchema.parse(JSON.parse(body));
  } catch {
    return { status: "error" };
  }
  const isPull = parsed.pull_request !== undefined;
  return {
    status: "ok",
    preview: {
      kind: "github",
      repo: `${target.owner}/${target.repo}`,
      number: target.number,
      type: isPull ? "pull" : "issue",
      title: parsed.title,
      state: isPull && parsed.pull_request?.merged_at ? "merged" : parsed.state,
    },
  };
};

export type PreviewStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
};

const valkeyStore: PreviewStore = {
  get: (key) => redis.get(key),
  set: async (key, value, ttlSeconds) => {
    await redis.set(key, value, "EX", ttlSeconds);
  },
};

const cacheKey = (spaceId: string, target: GitHubLinkTarget) =>
  `spaces:link-preview:v1:${spaceId}:${target.owner.toLowerCase()}/${target.repo.toLowerCase()}#${target.number}`;

const fetchBudget = ratelimit({ id: "spaces-link-preview", limit: FETCH_BUDGET_PER_MINUTE, windowSecs: 60 });

export type ResolvePreviewOptions = {
  /** Previews are cached per Space because a Space token may reveal private repositories. */
  spaceId: string;
  /** `cached` never leaves the process (SSR); `fill` fetches misses within the Space's budget. */
  mode: "cached" | "fill";
  /** Loaded once per call, only when a miss needs a fetch. */
  token?: () => Promise<string | null>;
  store?: PreviewStore;
  fetch?: typeof fetch;
  budget?: Pick<ReturnType<typeof ratelimit>, "check">;
};

/** Attaches previews to links; a link without a known preview keeps `preview: null`. */
export const resolveLinkPreviews = async <T extends Pick<SpaceItemLink, "url">>(
  links: T[],
  options: ResolvePreviewOptions,
): Promise<(T & { preview: SpaceItemLinkPreview | null })[]> => {
  const store = options.store ?? valkeyStore;
  let tokenPromise: Promise<string | null> | undefined;
  const loadToken = () => {
    tokenPromise ??= options.token ? options.token() : Promise.resolve(null);
    return tokenPromise;
  };
  const resolveOne = async (url: string): Promise<SpaceItemLinkPreview | null> => {
    const target = parseGitHubLink(url);
    if (!target) return null;
    const key = cacheKey(options.spaceId, target);
    let cached: string | null = null;
    try {
      cached = await store.get(key);
    } catch {
      // A cache outage degrades to a plain link; it never fails the item.
    }
    if (cached === MISSING) return null;
    if (cached) {
      try {
        return JSON.parse(cached) as SpaceItemLinkPreview;
      } catch {
        // Fall through to a refill.
      }
    }
    if (options.mode !== "fill") return null;
    try {
      if ((await (options.budget ?? fetchBudget).check(options.spaceId)).limited) return null;
    } catch {
      return null;
    }
    const result = await fetchGitHubPreview(target, { token: await loadToken(), fetch: options.fetch });
    try {
      if (result.status === "ok") await store.set(key, JSON.stringify(result.preview), PREVIEW_TTL_SECONDS);
      else if (result.status === "missing") await store.set(key, MISSING, MISSING_TTL_SECONDS);
      else if (result.status === "limited") await store.set(key, MISSING, LIMITED_TTL_SECONDS);
    } catch {
      // Not cached; the next view retries within the budget.
    }
    return result.status === "ok" ? result.preview : null;
  };
  return Promise.all(links.map(async (link) => ({ ...link, preview: await resolveOne(link.url) })));
};

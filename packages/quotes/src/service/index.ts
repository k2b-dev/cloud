/**
 * Quotes Service using ZenQuotes API with Redis caching.
 * Fetches a new quote every hour.
 */

import { coreSettings, logger } from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { redis } from "bun";

const log = logger("quotes");
const QUOTE_FETCH_TIMEOUT_MS = 400;

export type Quote = {
  text: string;
  author: string;
};

const CACHE_KEY = "quotes:current";
const CACHE_TTL_SECONDS = 60 * 60; // 1 hour

/**
 * Reads the cached quote from Redis; returns null when cache is empty or invalid.
 */
const getCachedQuote = async (): Promise<Quote | null> => {
  try {
    const cached = await redis.get(CACHE_KEY);
    if (!cached) return null;
    const quote = JSON.parse(cached) as unknown;
    return isQuote(quote) ? { text: quote.text.trim(), author: quote.author.trim() } : null;
  } catch {
    return null;
  }
};

/**
 * Stores the current quote in Redis with a fixed one-hour TTL.
 */
const setCachedQuote = async (quote: Quote): Promise<void> => {
  try {
    await redis.set(CACHE_KEY, JSON.stringify(quote), "EX", CACHE_TTL_SECONDS);
  } catch {
    // Cache failures are non-fatal.
  }
};

type ZenQuotesResponse = Array<{
  q: string;
  a: string;
  h: string;
}>;

const isQuote = (value: unknown): value is Quote => {
  if (!value || typeof value !== "object") return false;
  const quote = value as Record<string, unknown>;
  return (
    typeof quote.text === "string" && quote.text.trim().length > 0 && typeof quote.author === "string" && quote.author.trim().length > 0
  );
};

export const parseQuotePayload = (value: unknown): Quote | null => {
  if (!Array.isArray(value)) return null;
  const quote = value[0] as Partial<ZenQuotesResponse[number]> | undefined;
  if (!quote || typeof quote.q !== "string" || typeof quote.a !== "string") return null;

  const text = quote.q.trim();
  const author = quote.a.trim();
  if (!text || !author) return null;
  return { text, author };
};

/**
 * Fetches one quote from ZenQuotes and maps transport errors into `Result` failures.
 */
const fetchQuote = async (): Promise<Result<Quote>> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), QUOTE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch("https://zenquotes.io/api/random", {
      headers: {
        "User-Agent": `${((await coreSettings.get<string>("app.name")) || "App").replace(/\s+/g, "-")}/1.0`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      log.error("ZenQuotes API error", { status: response.status });
      return fail(err.internal("Failed to fetch quote"));
    }

    const quote = parseQuotePayload(await response.json());
    if (!quote) {
      log.error("ZenQuotes API returned invalid data");
      return fail(err.internal("Quote API returned no data"));
    }

    return ok(quote);
  } catch (error) {
    log.error("Failed to fetch quote", {
      error: error instanceof Error ? error.message : String(error),
      timeoutMs: QUOTE_FETCH_TIMEOUT_MS,
    });
    return fail(err.internal("Failed to fetch quote"));
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Returns the current quote, preferring cache and falling back to remote fetch + cache fill.
 */
const get = async (): Promise<Result<Quote>> => {
  const cached = await getCachedQuote();
  if (cached) return ok(cached);

  const fetched = await fetchQuote();
  if (!fetched.ok) return fetched;

  await setCachedQuote(fetched.data);
  return fetched;
};

export const quotesService = {
  quote: {
    get,
  },
};

export type QuotesService = typeof quotesService;

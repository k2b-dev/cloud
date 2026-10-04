import type { Hono } from "hono";
import { hc } from "hono/client";
import { insideMobileApp, renewAppSession } from "../browser/app-session";

export type CreateApiClientConfig = {
  baseUrl?: string;
};

// ==========================
// API Client
// ==========================

/**
 * A request from a page of the mobile app that answers `401` met an expired app session. The client renews it and
 * sends the request once more, so the action is not lost; Core already refused the first attempt before it ran.
 */
const fetchWithAppSession = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
  const response = await fetch(input, init);
  if (response.status !== 401 || !insideMobileApp() || init?.body instanceof ReadableStream) return response;
  if (!(await renewAppSession()).ok) return response;
  return fetch(input, init);
};

/**
 * Creates a typed Hono API client. On a page of the mobile app, it renews an expired app session and repeats the
 * request once.
 */
export const createApiClient = <TApi extends Hono<any, any, any>>(config: CreateApiClientConfig = {}) =>
  hc<TApi>(config.baseUrl ?? "/api", { fetch: fetchWithAppSession });

/**
 * Untyped fallback API client for core-only browser code.
 */
export const apiClient: any = hc("/api");

// ==========================
// Clipboard
// ==========================

/**
 * Copies text to the clipboard.
 * Fails silently with console error if clipboard API is unavailable.
 */
export const copyToClipboard = async (text: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.error("Failed to copy:", err);
  }
};

/**
 * Checks if a value is an image URL served by the API.
 * Used to determine if an image field contains an existing server URL or new base64 data.
 */
export const isImageUrl = (value: string | null | undefined): boolean => typeof value === "string" && value.includes("/avatar");

export const api = {
  create: createApiClient,
} as const;

export const clipboard = {
  copy: copyToClipboard,
} as const;

export const url = {
  isImage: isImageUrl,
} as const;

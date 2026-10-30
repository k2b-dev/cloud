/**
 * HTTP side of the notes server (pwas/notes/server). Error bodies carry a stable `code`;
 * the UI turns codes into its own sentences and never shows server text.
 */

export type ApiErrorCode =
  | "rate_limited"
  | "storage_full"
  | "too_large"
  | "file_too_large"
  | "unsupported_type"
  | "too_many_files"
  | "not_found"
  | "gone"
  | "blocked"
  | "forbidden"
  | "invalid"
  | "offline"
  | "unavailable";

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
  ) {
    super(code);
  }
}

const KNOWN: readonly ApiErrorCode[] = [
  "rate_limited",
  "storage_full",
  "too_large",
  "file_too_large",
  "unsupported_type",
  "too_many_files",
  "not_found",
  "gone",
  "blocked",
  "forbidden",
  "invalid",
];

const byStatus = (status: number): ApiErrorCode => {
  if (status === 404) return "not_found";
  if (status === 410) return "gone";
  if (status === 451) return "blocked";
  if (status === 403) return "forbidden";
  if (status === 413) return "too_large";
  if (status === 415) return "unsupported_type";
  if (status === 429) return "rate_limited";
  if (status === 507) return "storage_full";
  if (status >= 400 && status < 500) return "invalid";
  return "unavailable";
};

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, credentials: "omit", referrerPolicy: "no-referrer" });
  } catch {
    throw new ApiError(navigator.onLine ? "unavailable" : "offline", 0);
  }
  if (response.ok) return response;
  let code = byStatus(response.status);
  try {
    const body: unknown = await response.json();
    const reported = body && typeof body === "object" && "code" in body ? body.code : undefined;
    const known = KNOWN.find((entry) => entry === reported);
    if (known) code = known;
  } catch {
    // A proxy error page has no JSON body; the status decides.
  }
  throw new ApiError(code, response.status);
}

const text = (value: unknown): string => {
  if (typeof value !== "string" || !value) throw new ApiError("invalid", 200);
  return value;
};

const field = (body: unknown, key: string): unknown => (body && typeof body === "object" && key in body ? Reflect.get(body, key) : undefined);

export type LinkInfo = { role: "read" | "edit"; readId: string; title: string; snapshot: Uint8Array | null; liveAvailable: boolean };

export const api = {
  /** Uploads the note's Yjs state; both links come back. */
  async createPad(state: Uint8Array, title: string): Promise<{ readId: string; editId: string }> {
    const response = await request("/api/pads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accepted: true, title, snapshot: toBase64(state) }),
    });
    const body: unknown = await response.json();
    return { readId: text(field(body, "readId")), editId: text(field(body, "editId")) };
  },

  /** Never writes on the server: opening a link is not yet a human visit. */
  async link(linkId: string): Promise<LinkInfo> {
    const response = await request(`/api/pads/${encodeURIComponent(linkId)}`);
    const body: unknown = await response.json();
    const role = field(body, "role");
    if (role !== "read" && role !== "edit") throw new ApiError("invalid", 200);
    const title = field(body, "title");
    const snapshot = field(body, "snapshot");
    return {
      role,
      readId: text(field(body, "readId")),
      title: typeof title === "string" ? title : "",
      snapshot: typeof snapshot === "string" && snapshot ? fromBase64(snapshot) : null,
      liveAvailable: field(body, "liveAvailable") !== false,
    };
  },

  /** The signal after loading that a person opened the note; it keeps the note from expiring. */
  async opened(linkId: string): Promise<void> {
    await request(`/api/pads/${encodeURIComponent(linkId)}/opened`, { method: "POST" });
  },

  async deletePad(editId: string): Promise<void> {
    try {
      await request(`/api/pads/${encodeURIComponent(editId)}`, { method: "DELETE" });
    } catch (error) {
      // Already gone counts as deleted.
      if (error instanceof ApiError && (error.code === "not_found" || error.code === "gone")) return;
      throw error;
    }
  },

  async uploadFile(editId: string, file: Blob, key: string): Promise<{ key: string }> {
    const form = new FormData();
    form.set("key", key);
    form.set("file", file);
    const response = await request(`/api/pads/${encodeURIComponent(editId)}/files`, { method: "POST", body: form });
    const body: unknown = await response.json();
    return { key: text(field(body, "key")) };
  },

  fileUrl: (readId: string, key: string) => `/api/pads/${encodeURIComponent(readId)}/files/${encodeURIComponent(key)}`,

  async report(input: { linkId: string; reason: ReportReason; text: string; email?: string; confirmed: true }): Promise<{ number: string }> {
    const response = await request("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const body: unknown = await response.json();
    return { number: text(field(body, "number")) };
  },

  socketUrl: (linkId: string) => {
    const url = new URL(`/api/pads/${encodeURIComponent(linkId)}/ws`, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  },
};

export type ReportReason = "abuse" | "illegal" | "copyright" | "privacy" | "fraud";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export const shareUrl = (id: string) => new URL(`/p/${id}`, window.location.origin).toString();

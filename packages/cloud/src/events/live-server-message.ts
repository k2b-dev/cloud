/** The server's live wire messages; validation equivalence is checked against live-protocol. */
export type LiveServerMessage =
  | { t: "ready"; id: string; cursor: string }
  | { t: "event"; id: string; cursor: string; data: unknown }
  | { t: "progress"; cursor: string }
  | { t: "resync"; id: string; cursor: string }
  | { t: "revoked"; id: string; code: "not_found" | "access_denied" }
  | { t: "error"; code: string; message: string };

/** Strip undeclared keys just like the server-message schema. */
export const parseLiveServerMessage = (value: unknown): LiveServerMessage | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("t" in value)) return null;
  switch (value.t) {
    case "ready":
    case "resync":
    case "event": {
      if (!("id" in value) || typeof value.id !== "string" || !("cursor" in value) || typeof value.cursor !== "string") return null;
      if (value.t === "event") {
        // Zod v4 requires the key even though its value is unknown (and may be undefined).
        return "data" in value ? { t: value.t, id: value.id, cursor: value.cursor, data: value.data } : null;
      }
      return { t: value.t, id: value.id, cursor: value.cursor };
    }
    case "progress":
      return "cursor" in value && typeof value.cursor === "string" ? { t: value.t, cursor: value.cursor } : null;
    case "revoked":
      return "id" in value &&
        typeof value.id === "string" &&
        "code" in value &&
        (value.code === "not_found" || value.code === "access_denied")
        ? { t: value.t, id: value.id, code: value.code }
        : null;
    case "error":
      return "code" in value && typeof value.code === "string" && "message" in value && typeof value.message === "string"
        ? { t: value.t, code: value.code, message: value.message }
        : null;
    default:
      return null;
  }
};

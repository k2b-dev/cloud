export type DelimitedPreferences = { encoding: string; delimiter: string; view: "table" | "raw" };

/** Persist presentation choices only, never file contents. Ignore stale or corrupt storage. */
export const readDelimitedPreferences = (stored: string | null): DelimitedPreferences => {
  const defaults: DelimitedPreferences = { encoding: "utf-8", delimiter: "auto", view: "table" };
  try {
    const value: unknown = JSON.parse(stored ?? "null");
    if (!value || typeof value !== "object") return defaults;
    return {
      encoding:
        "encoding" in value &&
        typeof value.encoding === "string" &&
        ["utf-8", "windows-1252", "utf-16le", "utf-16be"].includes(value.encoding)
          ? value.encoding
          : defaults.encoding,
      delimiter:
        "delimiter" in value && typeof value.delimiter === "string" && ["auto", ",", ";", "\t", "|"].includes(value.delimiter)
          ? value.delimiter
          : defaults.delimiter,
      view: "view" in value && value.view === "raw" ? "raw" : "table",
    };
  } catch {
    return defaults;
  }
};

export const decodeDelimitedContent = (content: { encoding: "utf8" | "base64"; content: string }, encoding: string): string =>
  content.encoding === "utf8"
    ? content.content
    : new TextDecoder(encoding).decode(Uint8Array.from(atob(content.content), (char) => char.charCodeAt(0)));

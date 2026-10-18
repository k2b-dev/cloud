export type BrowserCode = "firefox" | "chrome" | "safari" | "edge" | "samsung" | "opera" | "other";
export type OsCode = "windows" | "macos" | "mac-or-ipad" | "ios" | "android" | "linux" | "chromeos" | "other";

// Bound work on untrusted headers before parsing; normal browser headers fit these budgets.
const USER_AGENT_BUDGET = 512;
const HINT_BUDGET = 256;
const BRAND_LIMIT = 16;

const hintBrowser = (hint: string): BrowserCode | undefined => {
  const brands: string[] = [];
  let offset = 0;
  for (let count = 0; count < BRAND_LIMIT && offset < hint.length; count++) {
    const end = hint.indexOf(",", offset);
    const entry = hint.slice(offset, end < 0 ? hint.length : end).trim();
    const match = /^"([^"\\]*)";v="[^"\\]*"$/.exec(entry);
    if (match?.[1]) brands.push(match[1]);
    if (end < 0) break;
    offset = end + 1;
  }
  if (brands.includes("Microsoft Edge")) return "edge";
  if (brands.includes("Opera") || brands.includes("Opera GX")) return "opera";
  if (brands.includes("Samsung Internet")) return "samsung";
  // GREASE varies punctuation and spacing around "Not A Brand".
  const named = brands.filter((brand) => brand.replace(/[^a-z]/gi, "").toLowerCase() !== "notabrand");
  if (named.some((brand) => brand !== "Chromium" && brand !== "Google Chrome")) return "other";
  if (named.includes("Google Chrome") || named.includes("Chromium")) return "chrome";
  return undefined;
};

const hintOs = (hint: string): OsCode | undefined => {
  switch (hint.trim()) {
    case '"Windows"':
      return "windows";
    case '"macOS"':
      return "macos";
    case '"Linux"':
      return "linux";
    case '"Android"':
      return "android";
    case '"Chrome OS"':
    case '"Chromium OS"':
      return "chromeos";
    case '"iOS"':
      return "ios";
    default:
      return undefined;
  }
};

export const describeBrowser = (headers: Headers): { browser: BrowserCode; os: OsCode } => {
  try {
    const brands = (headers.get("sec-ch-ua") ?? "").slice(0, HINT_BUDGET);
    const platform = (headers.get("sec-ch-ua-platform") ?? "").slice(0, HINT_BUDGET);
    const ua = (headers.get("user-agent") ?? "").slice(0, USER_AGENT_BUDGET);
    const apple =
      ua.includes("Macintosh") || ua.includes("Mac OS X") || ua.includes("iPhone") || ua.includes("iPad") || ua.includes("iPod");
    const uaBrowser: BrowserCode = ua.includes("SamsungBrowser/")
      ? "samsung"
      : ["Edg/", "EdgA/", "EdgiOS/", "Edge/"].some((token) => ua.includes(token))
        ? "edge"
        : ["OPR/", "OPT/", "OPiOS/", "Opera"].some((token) => ua.includes(token))
          ? "opera"
          : ua.includes("Firefox/") || ua.includes("FxiOS/")
            ? "firefox"
            : ["CriOS/", "Chrome/", "Chromium/"].some((token) => ua.includes(token))
              ? "chrome"
              : apple && ua.includes("Safari/") && ua.includes("Version/")
                ? "safari"
                : "other";
    const browser = hintBrowser(brands) ?? uaBrowser;
    const appleWebKit =
      ua.includes("AppleWebKit/") &&
      (uaBrowser === "safari" || ["CriOS/", "FxiOS/", "EdgiOS/", "OPiOS/"].some((token) => ua.includes(token)));
    const uaOs: OsCode = ua.includes("Windows")
      ? "windows"
      : ua.includes("CrOS")
        ? "chromeos"
        : ua.includes("Android")
          ? "android"
          : ["iPhone", "iPod", "iPad"].some((token) => ua.includes(token))
            ? "ios"
            : ua.includes("Macintosh") || ua.includes("Mac OS X")
              ? appleWebKit
                ? "mac-or-ipad"
                : "macos"
              : ua.includes("Linux") || ua.includes("X11")
                ? "linux"
                : "other";
    return { browser, os: hintOs(platform) ?? uaOs };
  } catch {
    return { browser: "other", os: "other" };
  }
};

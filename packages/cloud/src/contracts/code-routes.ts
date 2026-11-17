import { z } from "zod";

/** Literal, segment-based route grammar shared by checker, Core and SDK. Declaration order wins. */
export const CodeRouteSchema = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "DELETE", "ALL"]).describe("HTTP method, or ALL for every method."),
    path: z
      .string()
      .min(1)
      .max(200)
      .regex(/^\/(?:[A-Za-z0-9_-]+|:[A-Za-z][A-Za-z0-9_]*)(?:\/(?:[A-Za-z0-9_-]+|:[A-Za-z][A-Za-z0-9_]*))*\/?$|^\/$/)
      .refine((path) => {
        const names = path.split("/").filter((s) => s.startsWith(":"));
        return new Set(names).size === names.length;
      })
      .describe("Code-relative path with optional named segments."),
    public: z.boolean().describe("Whether the route accepts anonymous visitors without a user."),
    page: z.boolean().optional().describe("The checker found a reachable ctx.page call in this handler. Absent on older versions."),
    layout: z.literal("plain").optional().describe("Pages of this route render without the Cloud layout; omitted, they render inside it."),
  })
  .strict();
export type CodeRoute = z.infer<typeof CodeRouteSchema>;
/** Unambiguous first match; HEAD uses GET. URLs are decoded one segment at a time, never as a path. */
export function matchCodeRoute(route: CodeRoute, method: string, path: string): Record<string, string> | null {
  if (route.method !== "ALL" && route.method !== (method === "HEAD" ? "GET" : method)) return null;
  const segments = path === "/" ? [] : path.replace(/\/$/, "").slice(1).split("/");
  const pattern = route.path === "/" ? [] : route.path.replace(/\/$/, "").slice(1).split("/");
  if (segments.length !== pattern.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    let value: string;
    try {
      value = decodeURIComponent(segments[i]!);
    } catch {
      return null;
    }
    if (!value || /[\\/\u0000-\u001f\u007f]/.test(value) || value === "." || value === "..") return null;
    if (pattern[i]!.startsWith(":")) params[pattern[i]!.slice(1)] = value;
    else if (pattern[i] !== value) return null;
  }
  return params;
}
/** Relative SDK links resolve inside one Code. Encoded separators, dot segments and external URLs are forbidden. */
export function codeOwnPath(codeId: string, path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(path)) throw new Error("code_foreign_path");
  const pathname = path.split(/[?#]/, 1)[0]!;
  const base = `/code/${encodeURIComponent(codeId)}`;
  const relative = pathname === base || pathname.startsWith(`${base}/`) ? pathname.slice(base.length) || "/" : pathname;
  for (const segment of relative.split("/")) {
    const decoded = decodeURIComponent(segment);
    if (decoded === "." || decoded === ".." || /[\\/\u0000-\u001f\u007f]/.test(decoded)) throw new Error("code_foreign_path");
  }
  if (pathname.startsWith("/code/") && pathname !== base && !pathname.startsWith(`${base}/`)) throw new Error("code_foreign_path");
  return pathname === base || pathname.startsWith(`${base}/`) ? path : base + path;
}

/** Displayable page evidence; admission and the handler still decide whether the request succeeds. */
export function isCodePageRoute(route: { method: string; path: string; public: boolean; page?: boolean } | undefined): boolean {
  return (
    !!route && !route.public && route.page !== false && (route.method === "GET" || route.method === "ALL") && !route.path.includes(":")
  );
}

/** Current manifest entries as openable pages, home first. Shared by the Code head and version handoffs. */
export function codePageLinks<T extends { kind: string; route?: { method: string; path: string; public: boolean; page?: boolean } }>(
  codeId: string,
  entries: readonly T[],
) {
  const pages = entries.filter((entry) => entry.kind === "route" && isCodePageRoute(entry.route));
  const home = pages.find((entry) => entry.route!.path === "/") ?? pages[0];
  return (home ? [home, ...pages.filter((entry) => entry !== home)] : []).map((entry) => ({
    entry,
    href: codeOwnPath(codeId, entry.route!.path),
  }));
}

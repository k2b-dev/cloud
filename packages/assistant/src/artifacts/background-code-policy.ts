import type { FlatDatabaseRequest } from "./database-runtime";

/** Stored database grants retain their row-operation vocabulary. */
export function backgroundDatabaseOperation(operation: FlatDatabaseRequest["operation"]) {
  return operation === "query" ? "query" : `rows.${operation}`;
}

/** Every effect retains its service authorization; HTTP and RSQL also check task grants. */
export function backgroundCodeRouteAllowed(path: string, method: string): boolean {
  if (method === "POST")
    return (
      [
        "/runtime/compile",
        "/runtime/check/start",
        "/runtime/check/discard",
        "/runtime/check/record",
        "/runtime/check/gate",
        "/runtime/check/capability",
        "/runtime/action",
        "/runtime/ai",
        "/runtime/pdf",
        "/runtime/capabilities",
        "/presentations",
        "/runtime/http",
        "/runtime/secrets/list",
      ].includes(path) ||
      /^\/runtime\/http\/[a-f0-9-]+$/.test(path) ||
      /^\/[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz]{6}\/(?:database(?:\/maintenance)?(?:\/connect)?|storage(?:\/manage)?)$/.test(
        path,
      )
    );
  if (method === "PUT") return /^\/[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz]{6}\/storage\/file$/.test(path);
  return (
    method === "GET" &&
    (path === "/runtime/host.js" ||
      /^\/runtime\/chunks\/(?:csv|sheet|finance|pdf-read)$/.test(path) ||
      /^\/[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz]{6}(?:\/compiled|\/access|\/storage\/file)?$/.test(path))
  );
}

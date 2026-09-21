/** Every effect retains its service authorization; HTTP and RSQL also check task grants. */
export function backgroundCodeRouteAllowed(path: string, method: string): boolean {
  if (method === "POST")
    return (
      [
        "/runtime/compile",
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
      /^\/[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz]{6}(?:\/compiled|\/access|\/storage\/file)?$/.test(path))
  );
}

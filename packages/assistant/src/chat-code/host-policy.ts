/** Background turns use only runner services covered by their existing turn/mandate checks. */
export function backgroundChatCodeRouteAllowed(path: string, method: string): boolean {
  if (method === "POST")
    return (
      ["/runtime/views", "/runtime/ai", "/runtime/pdf", "/runtime/capabilities", "/runtime/http", "/runtime/secrets/list"].includes(path) ||
      /^\/runtime\/http\/[a-f0-9-]+$/.test(path)
    );
  return method === "GET" && /^\/runtime\/chunks\/(?:csv|sheet|finance|pdf-read)$/.test(path);
}

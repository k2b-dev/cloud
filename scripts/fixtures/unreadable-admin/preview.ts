import { resolve } from "node:path";
import { workspaceRoot } from "../../workspace";
import { previewViews } from "./views";

/** Fictional settings only: never connects to a Cloud installation or any infrastructure. */
export async function unreadableAdminPreview() {
  const build = Bun.spawn(
    [
      "bun",
      resolve(workspaceRoot, "packages/assistant/src/artifacts/workspace-browser-build.ts"),
      resolve(workspaceRoot, "packages/core/src/pages/admin/settings/_components/unreadable-admin.browser-harness.tsx"),
    ],
    { cwd: workspaceRoot, stdout: "pipe", stderr: "pipe" },
  );
  const code = await new Response(build.stdout).text();
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const { default: tailwind } = await import(Bun.resolveSync("bun-plugin-tailwind", resolve(workspaceRoot, "packages/ui")));
  const styles = await Bun.build({ entrypoints: [resolve(import.meta.dir, "styles.css")], plugins: [tailwind] });
  if (!styles.success) throw new AggregateError(styles.logs, "Could not build fixture styles");
  const css = await styles.outputs[0]!.text();
  const assetRoot = resolve(workspaceRoot, "packages/ui/dist");
  const assets = new Map<string, ReturnType<typeof Bun.file>>();
  for (const name of ["plex.css", "tabler.css"]) {
    const file = Bun.file(resolve(assetRoot, name));
    assets.set(`/assets/${name}`, file);
    for (const match of (await file.text()).matchAll(/url\(["']?\.\/([^\s)"']+)["']?\)/g)) {
      const relative = match[1]!.split(/[?#]/)[0]!;
      assets.set(`/assets/${relative}`, Bun.file(resolve(assetRoot, relative)));
    }
  }
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let current = previewViews(false);
  let late = false;
  const attempts = new Map<string, number>();
  const unreadable = new Map<string, boolean>();
  const mapping = (path: string): Record<string, string> => {
    if (path.includes("storage")) return { fileMiB: "assistant.storage_file_mib", totalMiB: "assistant.storage_total_mib" };
    if (path.includes("database")) return { url: "assistant.rsql_url", token: "assistant.rsql_api_token" };
    if (path.includes("linux-identities")) return { config: "linux.identity_config" };
    if (path.includes("contact-directory"))
      return {
        appId: "mail.contact_directory.app",
        suggest: "mail.contact_directory.suggest",
        resolve: "mail.contact_directory.resolve",
        read: "mail.contact_directory.read",
        listWritableBooks: "mail.contact_directory.list_writable_books",
        create: "mail.contact_directory.create",
      };
    if (path.includes("outgoing-mail"))
      return { contentDays: "outgoing_mail.content_retention_days", recordDays: "outgoing_mail.record_retention_days" };
    return { retentionDays: "logs.retention_days" };
  };
  const flags = (path: string) => Object.fromEntries(Object.values(mapping(path)).map((key) => [key, unreadable.get(key) ?? false]));
  const view = (path: string) => {
    if (path.includes("storage")) return { ...current.storage, unreadable: flags(path) };
    if (path.includes("database")) return { ...current.database, unreadable: flags(path) };
    if (path.includes("linux-identities"))
      return { ...current.linux, config: { ...current.linux.config, unreadable: unreadable.get("linux.identity_config") ?? false } };
    if (path.includes("contact-directory")) return { ...current.directory, unreadable: flags(path) };
    if (path.includes("outgoing-mail")) return { ...current.outgoing, unreadable: flags(path) };
    return { ...current.logs, unreadable: unreadable.get("logs.retention_days") ?? false };
  };
  const reset = (lateValue = false) => {
    late = lateValue;
    current = previewViews(late);
    attempts.clear();
    unreadable.clear();
    for (const entry of [current.storage, current.database, current.outgoing, current.directory])
      for (const [key, value] of Object.entries(entry.unreadable)) unreadable.set(key, value);
    unreadable.set("linux.identity_config", current.linux.config.unreadable);
    unreadable.set("logs.retention_days", current.logs.unreadable);
  };
  reset();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      if (assets.has(path)) return new Response(assets.get(path));
      if (path === "/bundle.js") return new Response(code, { headers: { "Content-Type": "text/javascript" } });
      if (path === "/ui.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
      if (path.startsWith("/api/")) {
        if (request.method === "PUT") {
          const body: Record<string, unknown> = await request.json();
          requests.push({ path, body });
          const count = attempts.get(path) ?? 0;
          attempts.set(path, count + 1);
          const fields = mapping(path);
          const supplied = Object.entries(fields).filter(([field]) => Object.hasOwn(body, field));
          if (late && count === 0 && supplied[0]) unreadable.set(supplied[0][1], true);
          const replace = Array.isArray(body.replaceUnreadable)
            ? body.replaceUnreadable
            : body.replaceUnreadable === true
              ? Object.values(fields)
              : [];
          if (supplied.some(([, key]) => unreadable.get(key) && !replace.includes(key)))
            return Response.json(
              { message: "Fictional stored value became unreadable. Review the draft and select replacement.", code: "setting_unreadable" },
              { status: 409 },
            );
          if (!late && count === 0)
            return Response.json(
              { message: "Fictional save rejected. Review the draft and retry.", code: "fixture_rejected" },
              { status: 503 },
            );
          const { replaceUnreadable: _replace, ...patch } = body;
          if (path.includes("storage")) current.storage = { ...current.storage, ...patch };
          else if (path.includes("database"))
            current.database = { ...current.database, ...patch, tokenSet: Boolean(body.token) || current.database.tokenSet };
          else if (path.includes("contact-directory")) current.directory.config = { ...current.directory.config, ...patch };
          else if (path.includes("outgoing-mail")) current.outgoing = { ...current.outgoing, ...patch };
          else if (path.includes("linux-identities") && body.config && typeof body.config === "object")
            current.linux.config = { ...current.linux.config, ...body.config };
          else if (typeof body.retentionDays === "number") current.logs.retentionDays = body.retentionDays;
          for (const [, key] of supplied) unreadable.set(key, false);
          if (path.includes("linux-identities")) {
            const { unreadable: _unreadable, ...config } = current.linux.config;
            return Response.json(config);
          }
          if (path.includes("contact-directory")) return Response.json(current.directory.config);
          return Response.json(view(path));
        }
        return Response.json(view(path));
      }
      if (path !== "/") return new Response("Not found", { status: 404 });
      if (url.searchParams.get("late") === "true") reset(true);
      return new Response(
        `<!doctype html><html class="${url.searchParams.get("theme") === "dark" ? "dark" : "light"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui.css"><link rel="stylesheet" href="/assets/plex.css"><link rel="stylesheet" href="/assets/tabler.css"></head><body class="k2b-ui"><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>`,
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  return {
    server,
    requests,
    reset() {
      requests.length = 0;
      reset();
    },
  };
}

if (import.meta.main) {
  if (Bun.argv.includes("--help")) {
    console.log(
      "Usage: bun --no-env-file scripts/fixtures/unreadable-admin/preview.ts --serve\nServes fictional #1408 settings for browser checks and screenshots on loopback.",
    );
  } else if (Bun.argv.includes("--serve")) {
    const { server } = await unreadableAdminPreview();
    console.log(server.url.href);
  } else throw new Error("Pass --serve or --help.");
}

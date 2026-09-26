import { join } from "node:path";
import { CLOUD_CLI_API_VERSION, type CloudCliPluginManifest, cloudCliPluginDigest, sha512Hex } from "@k2b/cloud/cli";

export type ServedPlugin = { manifest: CloudCliPluginManifest; files: Map<string, Uint8Array<ArrayBuffer>> };

let echoBundle: Uint8Array | undefined;

/**
 * The echo fixture as a Cloud application serves it. `variant` changes the
 * bundle bytes, so each variant is a different plugin version.
 */
export const servedEchoPlugin = async (version: string, variant = version): Promise<ServedPlugin> => {
  if (!echoBundle) {
    const result = await Bun.build({ entrypoints: [join(import.meta.dir, "echo-plugin", "src", "cli.ts")], target: "bun", format: "esm" });
    if (!result.success) throw new AggregateError(result.logs, "Failed to build the echo plugin fixture.");
    echoBundle = new Uint8Array(await result.outputs[0]!.arrayBuffer());
  }
  const encoder = new TextEncoder();
  const files = new Map<string, Uint8Array<ArrayBuffer>>([
    ["cli.js", new Uint8Array([...echoBundle, ...encoder.encode(`\n// ${variant}\n`)])],
    ["references/index.md", encoder.encode(`# Echo ${version}\n`)],
  ]);
  const list = [...files].map(([path, bytes]) => ({ path, size: bytes.byteLength, sha512: sha512Hex(bytes) }));
  return {
    manifest: {
      apiVersion: CLOUD_CLI_API_VERSION,
      name: "echo",
      app: "echo-app",
      version,
      entry: "cli.js",
      digest: cloudCliPluginDigest(list),
      files: list,
    },
    files,
  };
};

export type PluginCloudState = {
  plugins: ServedPlugin[];
  /** Status for every plugin route instead of content, e.g. 403. */
  status?: number;
  /** Bytes sent instead of a file's content, keyed by path. */
  tampered?: Map<string, Uint8Array<ArrayBuffer>>;
  authorizations: string[];
};

/** A Cloud that serves `state.plugins` the way applications do, plus `/api/echo` for the echo plugin. */
export const startPluginCloud = (state: PluginCloudState) =>
  Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      const authorization = request.headers.get("authorization") ?? "";
      state.authorizations.push(authorization);
      if (pathname === "/api/echo") return Response.json({ authorization, locale: request.headers.get("accept-language") });
      // Just enough OAuth for `cld login`: every code and refresh token is accepted.
      if (pathname === "/oauth/token") {
        return Response.json({ access_token: "login-access", token_type: "Bearer", expires_in: 3600, refresh_token: "login-refresh" });
      }
      if (pathname === "/oauth/revoke") return new Response(null, { status: 200 });
      if (!pathname.startsWith("/cli/plugins")) return new Response("not found", { status: 404 });
      if (!authorization) return Response.json({ message: "Authentication required" }, { status: 401 });
      if (state.status) return Response.json({ message: "denied" }, { status: state.status });
      if (pathname === "/cli/plugins") {
        return Response.json({
          plugins: state.plugins.map(({ manifest }) => ({ name: manifest.name, app: manifest.app, version: manifest.version })),
        });
      }
      const [, , , name, ...rest] = pathname.split("/");
      const plugin = state.plugins.find(({ manifest }) => manifest.name === name);
      const path = rest.join("/");
      if (!plugin) return new Response("not found", { status: 404 });
      if (path === "manifest.json") return Response.json(plugin.manifest);
      const bytes = state.tampered?.get(path) ?? plugin.files.get(path);
      return bytes ? new Response(bytes) : new Response("not found", { status: 404 });
    },
  });

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Glob } from "bun";
import { isPwaStaticAsset, type PwaStaticAsset } from "../contracts/pwa-assets";
import { sharedStylesheetVersion, versionedPublicHref } from "./static-assets";

/** Hash the final (post-rewrite, uncompressed) output, not Bun's chunk names or island IDs. */
export async function readPwaStaticAssets(root: string, appId: string, ssrPath: string, release: string): Promise<PwaStaticAsset[]> {
  const assets: PwaStaticAsset[] = [];
  const add = async (path: string, url: string, type: string, filenameHash?: string) => {
    const body = await readFile(path);
    const asset = { url, sha256: createHash("sha256").update(body).digest("hex"), bytes: body.byteLength, type };
    if ((!filenameHash || asset.sha256.startsWith(filenameHash)) && isPwaStaticAsset(asset)) assets.push(asset);
  };
  const ssr = join(root, "_ssr");
  if (existsSync(join(ssr, "manifest.json"))) {
    const manifest: unknown = JSON.parse(await readFile(join(ssr, "manifest.json"), "utf8"));
    if (
      typeof manifest === "object" &&
      manifest !== null &&
      "version" in manifest &&
      typeof manifest.version === "string" &&
      /^[a-f0-9]{16}$/.test(manifest.version)
    ) {
      for await (const file of new Glob("*.js").scan(ssr))
        await add(join(ssr, file), `${ssrPath}/${manifest.version}/${file}`, "text/javascript");
    }
  }
  const publicDir = join(root, "public");
  if (existsSync(publicDir)) {
    for await (const file of new Glob("**/*.{js,css,woff,woff2}").scan(publicDir)) {
      const path = join(publicDir, file);
      const url = `/public/${file}`;
      if (file === `${appId}/app.css`) {
        const version = createHash("sha256")
          .update(await readFile(path))
          .digest("hex")
          .slice(0, 16);
        await add(path, versionedPublicHref(url, version), "text/css");
      } else if (appId === "core" && /^(fonts|tabler-icons|global)\.css$/.test(file)) {
        const version = sharedStylesheetVersion(release);
        if (version) await add(path, versionedPublicHref(url, version), "text/css");
      } else {
        const hashed = /([a-f0-9]{64}|[a-f0-9]{16})\.(js|css|woff2?)$/.exec(file);
        if (!hashed) continue;
        const extension = file.slice(file.lastIndexOf(".") + 1);
        await add(path, url, extension === "js" ? "text/javascript" : extension === "css" ? "text/css" : `font/${extension}`, hashed[1]);
      }
    }
  }
  return assets.sort((a, b) => a.url.localeCompare(b.url));
}

import { cp, mkdir, mkdtemp, rename, rm, stat } from "fs/promises";
import { join, resolve } from "path";
import { buildAssets } from "./build-assets";
import { plugin } from "./ssr";

const root = resolve(import.meta.dir, "..");
const dist = join(root, "dist");
const staging = await mkdtemp(join(root, ".dist-build-"));
const previous = `${dist}.previous-${process.pid}`;

try {
  await buildAssets();

  const result = await Bun.build({
    entrypoints: [join(root, "src", "server.tsx")],
    outdir: staging,
    target: "bun",
    naming: "server.js",
    minify: true,
    sourcemap: "linked",
    plugins: [plugin()],
  });
  if (!result.success) throw new AggregateError(result.logs, "Website server build failed.");

  await mkdir(join(staging, "assets"), { recursive: true });
  await cp(join(root, "agent-skills"), join(staging, "agent-skills"), { recursive: true, force: true });
  await cp(join(root, ".fibel"), join(staging, ".fibel"), { recursive: true, force: true });
  await cp(join(root, "assets"), join(staging, "assets"), { recursive: true, force: true });

  const hadPreviousBuild = await stat(dist).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (hadPreviousBuild) await rename(dist, previous);
  try {
    await rename(staging, dist);
  } catch (error) {
    if (hadPreviousBuild) await rename(previous, dist);
    throw error;
  }
  await rm(previous, { recursive: true, force: true });
  console.log("Built Cloud website into docs-site/dist.");
} finally {
  await rm(staging, { recursive: true, force: true });
}

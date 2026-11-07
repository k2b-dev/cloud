import tailwind from "bun-plugin-tailwind";
import { cp, mkdir, rm } from "fs/promises";
import { dirname, join, resolve } from "path";
import { writeExampleRegistry } from "./ui/demo-sections/charts/examples/generate";

const siteRoot = resolve(import.meta.dir, "..");
const generated = join(siteRoot, "assets", "generated");
const fibelPublic = join(siteRoot, ".fibel", "public");
const solidRoot = dirname(Bun.resolveSync("solid-js/package.json", siteRoot));

export async function buildAssets() {
  // Chart showcase examples of every lane appear without a shared hand-kept list.
  writeExampleRegistry();
  await rm(generated, { recursive: true, force: true });
  await mkdir(generated, { recursive: true });
  const result = await Bun.build({
    entrypoints: [join(siteRoot, "src", "ui", "cloud-ui.css"), join(siteRoot, "src", "ui", "cloud-components.css")],
    outdir: generated,
    naming: "[name].[ext]",
    plugins: [tailwind],
    minify: process.env.NODE_ENV === "production",
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "Could not build the UI showcase stylesheets.");
  }

  await mkdir(fibelPublic, { recursive: true });
  const fibelStyles = await Bun.build({
    entrypoints: [join(siteRoot, "src", "fibel.css")],
    outdir: fibelPublic,
    naming: "styles.[ext]",
    plugins: [tailwind],
    minify: process.env.NODE_ENV === "production",
  });
  if (!fibelStyles.success) {
    throw new AggregateError(fibelStyles.logs, "Could not build the Fibel stylesheet.");
  }
  const compiledFibelStyles = await Bun.file(join(fibelPublic, "styles.css")).text();
  if (/@(?:apply|source|tailwind)\b/.test(compiledFibelStyles)) {
    throw new Error("Fibel stylesheet still contains uncompiled Tailwind directives.");
  }

  const solidMode = process.env.NODE_ENV === "production" ? "solid.js" : "dev.js";
  const solidWebMode = process.env.NODE_ENV === "production" ? "web.js" : "dev.js";
  const solidStoreMode = process.env.NODE_ENV === "production" ? "store.js" : "dev.js";
  await cp(join(solidRoot, "dist", solidMode), join(generated, "solid.js"), { force: true });
  await cp(join(solidRoot, "web", "dist", solidWebMode), join(generated, "solid-web.js"), { force: true });
  await cp(join(solidRoot, "store", "dist", solidStoreMode), join(generated, "solid-store.js"), { force: true });
}

if (import.meta.main) await buildAssets();

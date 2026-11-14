import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import { plugin } from "../src/site/config";

const root = resolve(import.meta.dir, "..");
if (Bun.argv.includes("--help")) {
  console.log(
    "Build the standalone SSR speedtest server, public assets and Node CLI. Usage: bun packages/speedtest/scripts/build.ts [--outdir PATH]",
  );
} else {
  const flag = Bun.argv.indexOf("--outdir");
  if (flag >= 0 && !Bun.argv[flag + 1]) throw new Error("--outdir needs a directory");
  const outdir = resolve(flag >= 0 ? Bun.argv[flag + 1]! : resolve(root, "dist"));
  const builds = [
    { entrypoints: [resolve(root, "src/main.ts")], outdir, target: "bun" as const, naming: "server.js", plugins: [plugin()] },
    { entrypoints: [resolve(root, "src/cli.ts")], outdir, target: "node" as const, naming: "cli.js" },
    {
      entrypoints: [resolve(root, "src/site/styles.css")],
      outdir: resolve(outdir, "assets"),
      naming: "site-[hash].[ext]",
      plugins: [tailwind],
    },
  ];
  for (const options of builds) {
    const result = await Bun.build({ ...options, minify: true, define: { "process.env.NODE_ENV": '"production"' } });
    if (!result.success) throw new AggregateError(result.logs, "Speedtest build failed");
    if (options.entrypoints[0]?.endsWith("styles.css")) {
      const stylesheet = result.outputs.find((output) => output.path.endsWith(".css"));
      if (!stylesheet) throw new Error("Missing speedtest stylesheet");
      await Bun.write(resolve(outdir, "assets.json"), JSON.stringify({ stylesheet: stylesheet.path.split("/").at(-1) }));
    }
  }
}

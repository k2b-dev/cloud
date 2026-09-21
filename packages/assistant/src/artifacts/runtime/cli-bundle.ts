import { env } from "@k2b/cloud/config";

let bundle: Promise<string> | undefined;
export function cliHostBundle() {
  bundle ??= (async () => {
    if (env.NODE_ENV === "production") {
      return Bun.file(new URL("./assistant-cli-host.js", import.meta.url)).text();
    }
    const build = Bun.spawn(
      [process.execPath, "build", new URL("./cli-host.ts", import.meta.url).pathname, "--target", "browser", "--minify"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, errors, exit] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
    if (exit !== 0) throw new Error(errors);
    return code;
  })().catch((error) => {
    bundle = undefined;
    throw error;
  });
  return bundle;
}

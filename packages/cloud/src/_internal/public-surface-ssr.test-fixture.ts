/** One real app plugin builds both the private app and public site islands. */
const root = Bun.argv[2]!;
const development = Bun.argv[3] === "development";
const { app } = await import(`${root}/src/config.ts`);
if (development) {
  Bun.plugin(app.plugin());
  await import(`${root}/src/server.tsx`);
} else {
  const result = await Bun.build({
    entrypoints: [`${root}/src/server.tsx`],
    outdir: `${root}/dist`,
    naming: "server.js",
    target: "bun",
    plugins: [app.plugin()],
    minify: true,
  });
  if (!result.success) throw new AggregateError(result.logs, "Public site bundle failed");
  const child = Bun.spawn([process.execPath, "--no-env-file", `${root}/dist/server.js`], {
    cwd: root,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 25000,
  });
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`Public site bundle exited ${exitCode}: ${stderr}`);
    process.stdout.write(stdout);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await child.exited;
    }
  }
}

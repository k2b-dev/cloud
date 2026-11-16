import { relative, resolve } from "node:path";
import { listIntegrationFiles } from "../../../scripts/run-tests";

const mailRoot = resolve(import.meta.dir, "..");
const workspaceRoot = resolve(mailRoot, "../..");

// These existing suites have explicit opt-ins rather than the shared infrastructure gate.
// Keep them in the integration entry point; their own guards decide whether to run.
const optInSuites = ["src/service/performance.integration.test.ts", "src/service/connectors/connector-conformance.integration.test.ts"];

/** Every selected file, or only the given ones; a file outside the selection is an error rather than a silent extra run. */
export const mailIntegrationCommand = async (only: string[] = []): Promise<string[]> => {
  const all = [...new Set([...(await listIntegrationFiles(mailRoot)), ...optInSuites])].sort();
  const unknown = only.filter((file) => !all.includes(relative(mailRoot, resolve(mailRoot, file))));
  if (unknown.length > 0) throw new Error(`not a Mail integration file: ${unknown.join(", ")}`);
  const files = only.length > 0 ? only.map((file) => relative(mailRoot, resolve(mailRoot, file))) : all;
  return [
    process.execPath,
    "--no-env-file",
    "test",
    "--isolate",
    "--timeout",
    "30000",
    "--preload",
    resolve(workspaceRoot, "scripts/fixtures/test-infra.ts"),
    "--preload",
    resolve(mailRoot, "test/integration-preload.ts"),
    ...files.map((file) => resolve(mailRoot, file)),
  ];
};

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "Usage: bun run test:integration [<file>...] [Bun test options]\n       bun run test:integration --list\n\nRuns Mail infrastructure suites with the shared gate and Mail's disposable database/Sync preload.\nGiven files, relative to packages/mail, it runs only those; each must be a selected file.\n--list prints the selected files without loading either preload.",
    );
  } else {
    const files = args.filter((arg) => /\.test\.tsx?$/.test(arg));
    const command = await mailIntegrationCommand(files);
    if (args.includes("--list")) console.log(command.slice(10).join("\n"));
    else {
      const options = args.filter((arg) => !files.includes(arg));
      const child = Bun.spawn([...command, ...options], { cwd: workspaceRoot, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      process.on("SIGINT", () => child.kill("SIGINT"));
      process.on("SIGTERM", () => child.kill("SIGTERM"));
      process.exit(await child.exited);
    }
  }
}

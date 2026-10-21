import { resolve } from "node:path";
import { listIntegrationFiles } from "../../../scripts/run-tests";

const mailRoot = resolve(import.meta.dir, "..");
const workspaceRoot = resolve(mailRoot, "../..");

// These existing suites have explicit opt-ins rather than the shared infrastructure gate.
// Keep them in the integration entry point; their own guards decide whether to run.
const optInSuites = ["src/service/performance.integration.test.ts", "src/service/connectors/connector-conformance.integration.test.ts"];

export const mailIntegrationCommand = async (): Promise<string[]> => {
  const files = [...new Set([...(await listIntegrationFiles(mailRoot)), ...optInSuites])].sort();
  return [
    process.execPath,
    "--no-env-file",
    "test",
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
      "Usage: bun run test:integration [Bun test options]\n       bun run test:integration --list\n\nRuns Mail infrastructure suites with the shared gate and Mail's disposable database/Sync preload.\n--list prints the selected files without loading either preload.",
    );
  } else {
    const command = await mailIntegrationCommand();
    if (args.includes("--list")) console.log(command.slice(9).join("\n"));
    else {
      const child = Bun.spawn([...command, ...args], { cwd: workspaceRoot, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      process.on("SIGINT", () => child.kill("SIGINT"));
      process.on("SIGTERM", () => child.kill("SIGTERM"));
      process.exit(await child.exited);
    }
  }
}

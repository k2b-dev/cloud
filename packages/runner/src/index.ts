import { CoreBridge } from "./bridge";
import { WorkerdEngine } from "./engine";
import { runnerEnvironment } from "./env";
import { probeJobIsolation } from "./jobs";
import { Runner } from "./runner";

const { key, origin } = await runnerEnvironment();
try {
  await probeJobIsolation();
} catch {
  console.error("runner_job_isolation_unavailable");
  process.exit(1);
}
const runner = new Runner(new CoreBridge(key, origin), new WorkerdEngine());
const stop = () => runner.stop();
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
try {
  await runner.start();
} finally {
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
}

export default runner;

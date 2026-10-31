import { CoreBridge } from "./bridge";
import { runnerEnvironment } from "./config";
import { WorkerdEngine } from "./engine";
import { Runner } from "./runner";

const { key, origin } = await runnerEnvironment();
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

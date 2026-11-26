import SpeedtestPane from "@k2b/speedtest/pane";
import ToolsScreen from "../ToolsScreen";

/**
 * The speed test on v2: the shared measurement pane of `@k2b/speedtest` inside the Tools frame, so it measures and
 * reads the same as the public speed test. The operator's server comes from the admin setting.
 */
export default function SpeedTest(props: { server?: string; enabled?: boolean }) {
  return (
    <ToolsScreen tool="speedtest">
      <SpeedtestPane server={props.server} enabled={props.enabled} />
    </ToolsScreen>
  );
}

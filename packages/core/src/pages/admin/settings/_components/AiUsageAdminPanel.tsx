import type { AiUsageReport } from "@valentinkolb/cloud/ai/admin";
import AiUsageExplorer from "./AiUsageExplorer.island";
export default function AiUsageAdminPanel(props: { report: AiUsageReport }) {
  return <AiUsageExplorer report={props.report} />;
}

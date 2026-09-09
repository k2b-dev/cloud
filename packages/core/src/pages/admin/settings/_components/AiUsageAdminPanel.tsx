import type { AiUsageReport } from "@k2b/cloud/ai/admin";
import AiUsageExplorer from "./AiUsageExplorer.island";
export default function AiUsageAdminPanel(props: { report: AiUsageReport }) {
  return <AiUsageExplorer report={props.report} />;
}

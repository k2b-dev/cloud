import { workflowAiBudgetSchema } from "../../config/workflow-ai";
import { coreSettings } from "../../services/settings/api";

export const getWorkflowAiBudget = async () =>
  workflowAiBudgetSchema.parse(JSON.parse(await coreSettings.get<string>("ai.workflow_budget")));

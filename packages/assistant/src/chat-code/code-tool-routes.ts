import { CODE_SOURCE_TOOLS } from "@k2b/cloud/ai";
import { ok } from "@k2b/stdlib";
import { AgentHostRequest, agentHost } from "./agent-host";
import { chatFileHandlers } from "./file-tools";
import { createCodeToolRoutes, registerCodeTool } from "./tool-routes";
export const chatCodeToolRoutes = createCodeToolRoutes();
for (const name of ["code_files", "code_file_stat", "code_file_copy"] as const) {
  if (name === "code_files") registerCodeTool(chatCodeToolRoutes, name, CODE_SOURCE_TOOLS.code_files.input, chatFileHandlers.code_files);
  if (name === "code_file_stat")
    registerCodeTool(chatCodeToolRoutes, name, CODE_SOURCE_TOOLS.code_file_stat.input, chatFileHandlers.code_file_stat);
  if (name === "code_file_copy")
    registerCodeTool(chatCodeToolRoutes, name, CODE_SOURCE_TOOLS.code_file_copy.input, chatFileHandlers.code_file_copy);
}
for (const name of ["code_run", "code_inspect", "code_stop", "code_export"] as const)
  registerCodeTool(
    chatCodeToolRoutes,
    name,
    AgentHostRequest.refine((input) => input.name === name),
    async (input, context) => ok(await agentHost.call(input, context)),
  );

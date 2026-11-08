import { CODE_SOURCE_TOOLS } from "@k2b/cloud/ai";
import { ok } from "@k2b/stdlib";
import { createCodeToolRoutes, registerCodeTool } from "../chat-code/tool-routes";
import { AgentHostRequest, agentHost } from "./agent-host";
import { artifactCodeHandlers } from "./code-tools";
export const codeToolRoutes = createCodeToolRoutes();
const register: <S extends import("zod").z.ZodType>(
  name: string,
  schema: S,
  run: (input: import("zod").z.output<S>, context: import("../chat-code/context").CodeToolContext) => Promise<unknown>,
) => void = (name, schema, run) => registerCodeTool(codeToolRoutes, name, schema, run);
register("code_database", CODE_SOURCE_TOOLS.code_database.input, artifactCodeHandlers.code_database);
register("code_database_export", CODE_SOURCE_TOOLS.code_database_export.input, artifactCodeHandlers.code_database_export);
register("code_manage_read", CODE_SOURCE_TOOLS.code_manage_read.input, artifactCodeHandlers.code_manage_read);
register("code_delete", CODE_SOURCE_TOOLS.code_delete.input, artifactCodeHandlers.code_delete);
register("code_database_read", CODE_SOURCE_TOOLS.code_database_read.input, artifactCodeHandlers.code_database_read);
register("code_database_clear", CODE_SOURCE_TOOLS.code_database_clear.input, artifactCodeHandlers.code_database_clear);
register("code_database_reset", CODE_SOURCE_TOOLS.code_database_reset.input, artifactCodeHandlers.code_database_reset);
register("code_storage_list", CODE_SOURCE_TOOLS.code_storage_list.input, artifactCodeHandlers.code_storage_list);
register("code_storage_delete", CODE_SOURCE_TOOLS.code_storage_delete.input, artifactCodeHandlers.code_storage_delete);
register("code_access_read", CODE_SOURCE_TOOLS.code_access_read.input, artifactCodeHandlers.code_access_read);
register("code_access_change", CODE_SOURCE_TOOLS.code_access_change.input, artifactCodeHandlers.code_access_change);
register("code_actions", CODE_SOURCE_TOOLS.code_actions.input, artifactCodeHandlers.code_actions);
register("code_sql", CODE_SOURCE_TOOLS.code_sql.input, artifactCodeHandlers.code_sql);
register("code_versions", CODE_SOURCE_TOOLS.code_versions.input, artifactCodeHandlers.code_versions);
register("code_list", CODE_SOURCE_TOOLS.code_list.input, artifactCodeHandlers.code_list);
register("code_read", CODE_SOURCE_TOOLS.code_read.input, artifactCodeHandlers.code_read);
register("code_history", CODE_SOURCE_TOOLS.code_history.input, artifactCodeHandlers.code_history);
register("code_fork", CODE_SOURCE_TOOLS.code_fork.input, artifactCodeHandlers.code_fork);
register("code_publish", CODE_SOURCE_TOOLS.code_publish.input, artifactCodeHandlers.code_publish);
register("code_unpublish", CODE_SOURCE_TOOLS.code_unpublish.input, artifactCodeHandlers.code_unpublish);
register("code_restore", CODE_SOURCE_TOOLS.code_restore.input, artifactCodeHandlers.code_restore);
register("code_update", CODE_SOURCE_TOOLS.code_update.input, artifactCodeHandlers.code_update);
register("code_create", CODE_SOURCE_TOOLS.code_create.input, artifactCodeHandlers.code_create);
register("code_write", CODE_SOURCE_TOOLS.code_write.input, artifactCodeHandlers.code_write);
register("code_import", CODE_SOURCE_TOOLS.code_import.input, artifactCodeHandlers.code_import);
register("code_remove", CODE_SOURCE_TOOLS.code_remove.input, artifactCodeHandlers.code_remove);

for (const name of ["code_action", "code_present", "code_check"] as const) {
  register(
    name,
    AgentHostRequest.refine((input) => input.name === name),
    async (input, context) => ok(await agentHost.call(input, context)),
  );
}

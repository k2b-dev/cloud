import { type CloudCliModule, defineCliCommands } from "@k2b/cloud/cli";
import { assistantChatCommands, assistantManagementCommands } from "./cli/chat";
import { assistantCodeCommands } from "./cli/code";
import { CODE_HOST_COMMAND } from "./cli/code-host";
import { assistantRootCommand } from "./cli/interactive";
import { assistantPersonalizationCommands } from "./cli/personalization";
import { assistantProjectCommands } from "./cli/projects";
import { assistantTaskCommands } from "./cli/tasks";

const commands = defineCliCommands({
  name: "assistant",
  summary: "Chat with the Cloud Assistant and manage chats, scheduled tasks, files, personalization, and Projects.",
  groupSummaries: {
    code: "Build and manage Studio Apps and actions",
    "studio-admin": "Administer Studio resources, data and database settings",
    actions: "Review and resolve pending turn actions",
    chats: "Create, inspect, and manage Assistant chats",
    files: "Manage files in Assistant chats",
    messages: "Inspect, retry, and fork Assistant messages",
    resources: "Find structured Cloud resources used in Assistant chats",
    personalization: "Manage personal facts, preferences, and learning",
    prefs: "View and update Assistant preferences",
    projects: "Manage shared Assistant Projects",
    "projects access": "Manage Project access grants",
    "projects files": "Manage Project files",
    "projects knowledge": "Manage Project knowledge",
    "projects references": "Manage Project Cloud references",
    "projects skills": "Manage Skills linked to a Project",
    tasks: "Manage one-time and recurring chat tasks",
    turns: "Watch, steer, and stop Assistant turns",
  },
  commands: [
    assistantRootCommand,
    ...assistantCodeCommands,
    ...assistantChatCommands,
    ...assistantManagementCommands,
    ...assistantPersonalizationCommands,
    ...assistantProjectCommands,
    ...assistantTaskCommands,
  ],
});

/**
 * `cld assistant code-host` is the browser code host that `createCliCodeHost`
 * spawns as a child of the same `cld`; it needs the parent's IPC channel and
 * never appears in help.
 */
const module: CloudCliModule = {
  ...commands,
  requiresCloudFor: (args, flags) => args[0] !== CODE_HOST_COMMAND && (commands.requiresCloudFor?.(args, flags) ?? true),
  run: async (ctx) => {
    if (ctx.args[0] !== CODE_HOST_COMMAND) return commands.run(ctx);
    if (!process.send) throw new Error("Code host requires a parent CLI connection");
    (await import("./cli/code-host-process")).startCliCodeHostProcess();
    return 0;
  },
};

export default module;

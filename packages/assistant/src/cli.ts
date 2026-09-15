import { assistantCodeCommands } from "./cli/code";
import { defineCliCommands } from "@k2b/cloud/cli";
import { assistantChatCommands, assistantManagementCommands } from "./cli/chat";
import { assistantRootCommand } from "./cli/interactive";
import { assistantPersonalizationCommands } from "./cli/personalization";
import { assistantProjectCommands } from "./cli/projects";
import { assistantTaskCommands } from "./cli/tasks";

const module = defineCliCommands({
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

export default module;

/** Internal subprocess entry for the standalone Cloud CLI. Requires parent IPC. */
export async function startCliCodeHostProcess() {
  if (!process.send) throw new Error("Code host requires a parent CLI connection");
  (await import("./cli/code-host-process")).startCliCodeHostProcess();
}

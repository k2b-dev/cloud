import { type CloudCliModule, defineCliCommands } from "@k2b/cloud/cli";
import { assistantAcpCommand } from "./cli/acp";
import { assistantApprovalCommands } from "./cli/approvals";
import { assistantChatCommands, assistantManagementCommands } from "./cli/chat";
import { assistantRootCommand } from "./cli/interactive";
import { assistantPersonalizationCommands } from "./cli/personalization";
import { assistantProjectCommands, projectAccessContext } from "./cli/projects";
import { assistantSkillCommands } from "./cli/skills";
import { assistantTaskCommands } from "./cli/tasks";

const commands = defineCliCommands({
  name: "assistant",
  alias: "ai",
  shortcuts: { acp: "acp" },
  summary: "Chat with the Cloud Assistant and manage chats, routines, files, personalization, and Projects.",
  groupSummaries: {
    approvals: "List and revoke remembered Cloud approvals",
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
    skills: "List Cloud Skills and move them to and from Agent Skills folders",
    "skills access": "Manage Skill access grants",
    tasks: "Manage routines, called tasks in the CLI, that run once or repeatedly in a chat",
    turns: "Watch, steer, and stop Assistant turns",
  },
  commands: [
    assistantRootCommand,
    assistantAcpCommand,
    ...assistantApprovalCommands,
    ...assistantChatCommands,
    ...assistantManagementCommands,
    ...assistantPersonalizationCommands,
    ...assistantProjectCommands,
    ...assistantSkillCommands,
    ...assistantTaskCommands,
  ],
});

export default { ...commands, run: (ctx) => commands.run(projectAccessContext(ctx)) } satisfies CloudCliModule;

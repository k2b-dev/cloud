/** Browser-only test probes. Mount and dispose application islands through their public APIs. */
export { collectContextAwareCommands } from "./command-bridge";
export { contextCommandsWithShortcuts } from "./command-shortcuts";
export { registerGlobalSearchHost } from "./search-bridge";
export { readWorkspaceNavigation } from "../ssr/workspace-navigation";

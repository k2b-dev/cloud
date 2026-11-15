/**
 * The one client function `openCommand` loads on demand. A dynamic import keeps every export of the module it loads,
 * so loading `./client` itself would put all of it, block text and chart code included, into each island that can
 * open a Command (the Chat island's budget in `packages/chat/src/frontend/ChatWorkspace.bundle.test.ts`).
 */
export { resolveCommand } from "./client";

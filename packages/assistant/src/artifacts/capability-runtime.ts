export * from "../chat-code/capability-runtime";

import { createRuntimeCapabilities } from "../chat-code/capability-runtime";
import { resolveRuntimeResource } from "./runtime-resource";
export const runtimeCapabilities = createRuntimeCapabilities(resolveRuntimeResource);

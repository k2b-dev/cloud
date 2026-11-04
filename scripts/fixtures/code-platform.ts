/** Internal platform seams for cross-application integration tests only. */
export { compileCapabilities, invokeCompiledCapability } from "../../packages/cloud/src/_internal/capabilities";
export { createCodeOwnerRoutes } from "../../packages/cloud/src/_internal/code-owner";
export * as codeOwnerProofs from "../../packages/cloud/src/code/owner-proof";
export { signCodeOwnerRead } from "../../packages/cloud/src/code/owner-proof";

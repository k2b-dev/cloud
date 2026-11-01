/** Internal platform seams for cross-application integration tests only. */
export { compileCapabilities, invokeCompiledCapability } from "../../packages/cloud/src/_internal/capabilities";
export { createCodeAccessAuthorityRoutes } from "../../packages/cloud/src/_internal/code-access-authority";
export { codeAccessBindings, removeCodeAccess, setCodeAccess } from "../../packages/cloud/src/code/access";
export * as codeAccessProofs from "../../packages/cloud/src/code/access-proof";
export { type CodeAccessProofClaims, signCodeAccessProof, verifyCodeAccessProof } from "../../packages/cloud/src/code/access-proof";

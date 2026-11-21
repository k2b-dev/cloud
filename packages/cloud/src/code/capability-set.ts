import type { NormalizedCapabilityCall } from "../contracts/capabilities";
import type { CodeVersionPermission } from "../contracts/code-version";
import { CodeBridgeRefusal } from "./bridge-contract";

/** Checked permissions bound the executable version; current policy and resource access still apply.
 * The checker records target and ref coordinates as separate rows for the same operation.
 * A dynamic ID permits other IDs of that Type; current account rights still apply.
 */
export function requireCodeCapabilityDeclared(
  call: NormalizedCapabilityCall,
  permissions: readonly Pick<CodeVersionPermission, "operation" | "target">[],
): void {
  const declared = permissions.filter((permission) => permission.operation === call.capability);
  const matches = (actual: NormalizedCapabilityCall["target"]) =>
    declared.some(({ target }) =>
      actual === null ? target === null : target !== null && target.type === actual.type && (target.id === actual.id || target.id === null),
    );
  if (!matches(call.target) || !Object.values(call.refs).every(matches)) throw new CodeBridgeRefusal("code_capability_undeclared", 403);
}

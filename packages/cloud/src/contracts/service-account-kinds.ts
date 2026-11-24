/**
 * Whether an account is an agent. Agents carry the kind `agent`; accounts created before agents existed carry
 * `standalone` and behave the same. Show both as "Agent" with the robot icon.
 *
 * A leaf module without imports, so browser code can use it through `@k2b/cloud/contracts/service-account-kinds`
 * without pulling the contract schemas into its bundle.
 */
export const isAgentServiceAccountKind = (kind: string | null | undefined): kind is "agent" | "standalone" =>
  kind === "agent" || kind === "standalone";

import type { CapabilityOrigin, CapabilityVia } from "../contracts/capabilities";

/** Visible provenance never changes the authority of an invocation. */
export const capabilityVia = (origin: CapabilityOrigin): CapabilityVia => (origin === "assistant" || origin === "mcp" ? origin : null);

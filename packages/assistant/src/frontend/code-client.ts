import { invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities";
import type { CodeQueryInvoke } from "../code-summary";

/** The browser calls Core's public Code queries with the person's session, like any application page. */
export const browserCodeInvoke: CodeQueryInvoke = (invocation, schema) => invokeCapabilityWithDataSchema(invocation, schema);

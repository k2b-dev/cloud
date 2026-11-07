import { crypto } from "@k2b/stdlib";
import { canonicalJson } from "../../shared/canonical-json";

export { canonicalJson as canonicalWorkflowJson, normalizeJson as normalizeWorkflowJson } from "../../shared/canonical-json";

export const hashWorkflowJson = (value: unknown): Promise<string> => crypto.common.hash(canonicalJson(value));

export const hashWorkflowSource = (source: string): Promise<string> => crypto.common.hash(source);

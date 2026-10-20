import { flag } from "@k2b/cloud/cli";
import { SOURCE_KINDS } from "../contracts";

export const JSON_INPUT = flag.input({
  name: "batch",
  fileName: "file",
  fileAliases: ["f"],
  stdinName: "stdin",
  valueLabel: "json",
});

export const bearerTokenFlags = {
  bearerTokenFile: flag.string({ name: "bearer-token-file", valueLabel: "path", description: "Read the metrics bearer token from a file" }),
  bearerTokenStdin: flag.boolean({ name: "bearer-token-stdin", description: "Read the metrics bearer token from stdin" }),
};

export const baseFlag = { base: flag.string({ description: "Pulse base ID or exact name" }) };
export const sourceKindFlag = flag.enum(SOURCE_KINDS, { name: "kind", description: "Source kind", required: true });

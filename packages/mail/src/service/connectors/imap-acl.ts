import type { ImapFlow } from "imapflow";
import { encodePath } from "imapflow/lib/tools.js";
import type { ConnectorCapabilities, FolderRightsSource } from "../../contracts";

type ImapAttribute = { type: string; value: string };
type ImapUntagged = { attributes?: unknown[] };
type ImapCommandResponse = { next(): void };
type ImapFlowRaw = ImapFlow & {
  exec(
    command: string,
    attributes?: ImapAttribute[] | false,
    options?: { untagged?: Record<string, (response: ImapUntagged) => Promise<void> | void> },
  ): Promise<ImapCommandResponse>;
};

type EffectiveFolderRights = {
  rights: string[];
  source: FolderRightsSource;
  rawAclRights: string | null;
};

const attributeValue = (attribute: unknown): string | null => {
  if (!attribute || typeof attribute !== "object" || !("value" in attribute)) return null;
  const value = (attribute as { value?: unknown }).value;
  return typeof value === "string" ? value : null;
};

export const mapImapAclRights = (rawRights: string, capabilities: Pick<ConnectorCapabilities, "move" | "uidplus">): string[] => {
  const rights = new Set(rawRights);
  const canDeleteMessages = rights.has("d") || (rights.has("t") && rights.has("e"));
  const mapped: string[] = [];
  if (rights.has("r")) mapped.push("read");
  if (rights.has("s") && rights.has("w")) mapped.push("write_flags");
  if (rights.has("i")) mapped.push("insert");
  if (canDeleteMessages && (capabilities.move || capabilities.uidplus)) mapped.push("move");
  if (canDeleteMessages && capabilities.uidplus) mapped.push("delete_messages");
  if (rights.has("k") || rights.has("c")) mapped.push("create_children");
  if (rights.has("x") || rights.has("d")) mapped.push("delete_folder");
  if (rights.has("a")) mapped.push("administer_acl");
  return mapped;
};

export const readImapAclRights = async (
  client: ImapFlow,
  path: string,
  capabilities: Pick<ConnectorCapabilities, "acl" | "move" | "uidplus">,
): Promise<EffectiveFolderRights | null> => {
  if (!capabilities.acl) return null;
  const encodedPath = encodePath(client, path);
  let rawRights: string | null = null;
  const response = await (client as ImapFlowRaw).exec(
    "MYRIGHTS",
    [{ type: encodedPath.includes("&") ? "STRING" : "ATOM", value: encodedPath }],
    {
      untagged: {
        MYRIGHTS: (untagged) => {
          rawRights = attributeValue(untagged.attributes?.[1]);
        },
      },
    },
  );
  response.next();
  if (rawRights === null) {
    throw Object.assign(new Error("IMAP ACL server returned no MYRIGHTS value"), { code: "IMAP_ACL_INVALID_RESPONSE" });
  }
  return {
    rights: mapImapAclRights(rawRights, capabilities),
    source: "acl",
    rawAclRights: rawRights,
  };
};

export const selectFallbackRights = (
  readOnly: boolean,
  capabilities: Pick<ConnectorCapabilities, "move" | "uidplus">,
): EffectiveFolderRights => ({
  rights: readOnly
    ? ["read"]
    : [
        "read",
        "write_flags",
        "insert",
        ...(capabilities.move || capabilities.uidplus ? ["move"] : []),
        ...(capabilities.uidplus ? ["delete_messages"] : []),
      ],
  source: "select",
  rawAclRights: null,
});

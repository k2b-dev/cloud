import { type ResourceApiKey, ResourceApiKeys, type ResourceApiKeysProps } from "@valentinkolb/cloud/access/ui";

type ItemApiKeysProps = {
  initialKeys: ResourceApiKey[];
  createKey: ResourceApiKeysProps["createKey"];
  revokeKey: ResourceApiKeysProps["revokeKey"];
};

export function ItemApiKeys(props: ItemApiKeysProps) {
  return (
    <ResourceApiKeys
      title="API keys"
      description="Keys for integrations that work with this item."
      initialKeys={props.initialKeys}
      createKey={props.createKey}
      revokeKey={props.revokeKey}
    />
  );
}

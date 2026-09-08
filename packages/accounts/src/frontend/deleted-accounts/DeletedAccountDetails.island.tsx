import { Button, DescriptionList, IconButton, isStructuredDataValue, prompts, StructuredDataPreview } from "@k2b/ui";
import { useAccountsMessages } from "../messages";

type Props = {
  displayName: string;
  uid: string;
  mail?: string | null;
  previousProvider?: string | null;
  previousProfile?: string | null;
  reason: string;
  deletedAt: string;
  metadata: Record<string, unknown> | null;
};

export default function DeletedAccountDetails(props: Props) {
  const messages = useAccountsMessages();
  const open = async () => {
    await prompts.dialog<void>(
      (close) => (
        <div class="flex flex-col gap-4">
          <DescriptionList
            columns={2}
            items={[
              { term: messages().account, description: props.displayName },
              { term: "UID", description: props.uid },
              { term: messages().email, description: props.mail || "—" },
              { term: messages().provider, description: props.previousProvider || "—" },
              { term: messages().profile, description: props.previousProfile || "—" },
              { term: messages().reason, description: props.reason },
              { term: messages().deleted, description: props.deletedAt },
            ]}
          />
          <StructuredDataPreview
            title={messages().metadata}
            data={isStructuredDataValue(props.metadata) ? props.metadata : null}
            empty={messages().noMetadata}
          />
          <div class="flex justify-end">
            <Button size="sm" variant="secondary" onClick={() => close()}>
              {messages().close}
            </Button>
          </div>
        </div>
      ),
      { title: props.displayName, icon: "ti ti-history-toggle", size: "large" },
    );
  };

  return (
    <IconButton size="sm" label={messages().showDetails} onClick={open}>
      <i class="ti ti-eye text-xs" />
    </IconButton>
  );
}

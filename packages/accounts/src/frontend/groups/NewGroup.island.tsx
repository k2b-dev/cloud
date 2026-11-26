import { Button } from "@k2b/ui";
import { useAccountsMessages } from "../messages";
import { useNewGroup } from "./new-group";

/** The "New group" button of the v1 group pages (relations); the v2 group list opens the same dialog from its head. */
export default function NewGroup(props: { freeIpaEnabled?: boolean; linuxEnabled: boolean }) {
  const messages = useAccountsMessages();
  const newGroup = useNewGroup(props);
  return (
    <Button size="sm" onClick={() => void newGroup.open()} disabled={newGroup.opening()}>
      {messages().newGroup}
    </Button>
  );
}

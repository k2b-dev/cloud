import { createSignal } from "solid-js";
import { ActionMenu } from "@k2b/ui/v2/overlays";

/** The "…" menu of an open mail (ui-sdk Menu). */
export default function MailMenu(props: { subject: string }) {
  const [last, setLast] = createSignal("");
  return (
    <>
      <ActionMenu
        trigger={{ label: `Aktionen für ${props.subject}`, icon: "dots", variant: "ghost", iconOnly: true }}
        items={[
          { value: "reply", label: "Antworten", icon: "reply" },
          { value: "unread", label: "Als ungelesen markieren", icon: "unread" },
          { value: "archive", label: "Archivieren", icon: "archive" },
          { separator: true },
          { value: "delete", label: "Löschen", icon: "trash", tone: "bad" },
        ]}
        onAction={setLast}
      />
      <span class="k2-sr" role="status" data-testid="menu-action">
        {last()}
      </span>
    </>
  );
}

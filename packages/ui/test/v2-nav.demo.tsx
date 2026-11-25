import { createSignal } from "solid-js";
import { Nav, Pane, Text, Workspace } from "../src/v2";

// A mailbox's sidebar as the mockup draws it (mail.html): the folders of the open mailbox, then "Mehr", which folds the
// archive, the bin and spam away, then the mailbox's own folders. A second folding entry holds the open folder, so it
// starts open. "Spam" opens in place, so the open entry can move into a closed fold. The group has a "…" with its deeds,
// the mailbox "Kontakt" a "…" of its own; each deed lands in `window.__navDeeds`.

declare global {
  interface Window {
    __openSpam?: () => void;
    __navDeeds?: string[];
  }
}

const did = (deed: string) => () => {
  window.__navDeeds = [...(window.__navDeeds ?? []), deed];
};

export function Demo() {
  const [current, setCurrent] = createSignal("Offen");
  if (typeof window !== "undefined") window.__openSpam = () => setCurrent("Spam");
  const place = (label: string, icon: string) => ({
    label,
    icon,
    nested: true,
    current: current() === label,
    onClick: () => setCurrent(label),
  });
  return (
    <Workspace
      sidebar={
        <Nav
          title="Mail"
          icon="mail"
          groups={[
            {
              label: "Postfächer",
              action: {
                label: "Postfächer verwalten",
                items: [
                  { label: "Neues Postfach", icon: "mail-plus", onClick: did("new-mailbox") },
                  { label: "Gelöschte Postfächer", icon: "trash", onClick: did("deleted-mailboxes") },
                ],
              },
              items: [
                {
                  label: "Kontakt",
                  icon: "flag",
                  count: 7,
                  onClick: did("open:kontakt"),
                  menu: [
                    { label: "Lösen", icon: "pinned-off", onClick: did("unpin:kontakt") },
                    { label: "Ausblenden", icon: "eye-off", onClick: did("hide:kontakt") },
                  ],
                },
                place("Posteingang", "inbox"),
                place("Gesendet", "send"),
                {
                  label: "Mehr",
                  nested: true,
                  items: [place("Archiv", "archive"), place("Papierkorb", "trash"), place("Spam", "alert-octagon")],
                },
                place("Lieferanten", "folder"),
                { label: "Rechnungen", items: [place("Offen", "folder"), place("Bezahlt", "folder")] },
              ],
            },
          ]}
        />
      }
    >
      <Pane label="Liste">
        <Text>{current()}</Text>
      </Pane>
    </Workspace>
  );
}

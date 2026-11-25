import { createSignal } from "solid-js";
import { Nav, Pane, Text, Workspace } from "../src/v2";

// A mailbox's sidebar as the mockup draws it (mail.html): the folders of the open mailbox, then "Mehr", which folds the
// archive, the bin and spam away, then the mailbox's own folders. A second folding entry holds the open folder, so it
// starts open. "Spam" opens in place, so the open entry can move into a closed fold.

declare global {
  interface Window {
    __openSpam?: () => void;
  }
}

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
              items: [
                { label: "Kontakt", icon: "flag" },
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

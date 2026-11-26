import { createSignal } from "solid-js";
import { Button, Kbd, List, Pane, Row, Section, Workspace } from "../src/v2";

// Invitations a person withdraws: the row's own action leaves while it has the focus, and the row says what happened in
// its status. One row keeps a second button, one opens a page, one has nothing else to focus.

export function Demo() {
  const [withdrawn, setWithdrawn] = createSignal<string[]>([]);
  const gone = (id: string) => withdrawn().includes(id);
  const withdraw = (id: string) => () => setWithdrawn([...withdrawn(), id]);
  return (
    <Workspace>
      <Pane label="Einladungen">
        <Section icon="mail" title="Offene Einladungen" count={3}>
          <List label="Offene Einladungen">
            <Row
              icon="mail"
              lines={["lea.brandt@holzwerk-brandt.de", "eingeladen am 21. Nov."]}
              status={gone("lea") ? "Zurückgezogen" : ""}
              action={gone("lea") ? undefined : { label: "Zurückziehen", icon: "x", onClick: withdraw("lea") }}
              end={<Button variant="ghost" icon="copy" label="Link kopieren" />}
            />
            <Row
              icon="mail"
              lines={["einkauf@stadtwerke-auental.de", "eingeladen am 18. Nov."]}
              href="#einkauf"
              status={gone("einkauf") ? "Zurückgezogen" : ""}
              action={gone("einkauf") ? undefined : { label: "Zurückziehen", icon: "x", onClick: withdraw("einkauf") }}
            />
            <Row
              icon="mail"
              lines={["tobias.kern@werkstatt.example", "eingeladen am 12. Nov."]}
              status={gone("tobias") ? "Zurückgezogen" : ""}
              action={gone("tobias") ? undefined : { label: "Zurückziehen", icon: "x", onClick: withdraw("tobias") }}
            />
          </List>
        </Section>
        <Section icon="keyboard" title="Kurzbefehle">
          <List label="Kurzbefehle">
            <Row icon="search" lines={["Suchen"]} end={<Kbd keys="mod+k" platform="apple" />} />
            <Row icon="send" lines={["Senden"]} end={<Kbd keys="mod+enter" platform="other" />} />
          </List>
        </Section>
      </Pane>
    </Workspace>
  );
}

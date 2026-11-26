import { createSignal } from "solid-js";
import { Button, Input, Kbd, List, Pane, Row, Section, Workspace } from "../src/v2";

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
        <Section icon="users" title="Freigaben" count={5}>
          <List label="Freigaben">
            {/* a row that opens a page and keeps a button: the button comes before the row's link */}
            <Row
              icon="user"
              lines={["Jana Petersen", "Bearbeiten"]}
              href="#jana"
              status={gone("jana") ? "Entzogen" : ""}
              action={gone("jana") ? undefined : { label: "Entziehen", icon: "x", onClick: withdraw("jana") }}
              end={<Button variant="ghost" icon="mail" label="Jana schreiben" />}
            />
            {/* a button that is hidden cannot take the focus; the next place in the row takes it */}
            <Row
              icon="user"
              lines={["Jonas Wolf", "Lesen"]}
              href="#jonas"
              status={gone("jonas") ? "Entzogen" : ""}
              action={gone("jonas") ? undefined : { label: "Entziehen", icon: "x", onClick: withdraw("jonas") }}
              end={
                <span hidden>
                  <Button variant="ghost" icon="mail" label="Jonas schreiben" />
                </span>
              }
            />
            {/* buttons the test shrinks to 0 x 0 px and makes invisible: neither can take the focus */}
            <Row
              icon="user"
              lines={["Lea Brandt", "Lesen"]}
              href="#lea"
              status={gone("lea-b") ? "Entzogen" : ""}
              action={gone("lea-b") ? undefined : { label: "Entziehen", icon: "x", onClick: withdraw("lea-b") }}
              end={<Button variant="ghost" icon="phone" label="Lea anrufen" />}
            />
            <Row
              icon="user"
              lines={["Tim Kern", "Lesen"]}
              href="#tim"
              status={gone("tim") ? "Entzogen" : ""}
              action={gone("tim") ? undefined : { label: "Entziehen", icon: "x", onClick: withdraw("tim") }}
              end={<Button variant="ghost" icon="phone" label="Tim anrufen" />}
            />
            {/* a deed that moves the focus on purpose: the row leaves it where it went */}
            <Row
              icon="user"
              lines={["Mira Aydın", "Lesen"]}
              status={gone("mira") ? "Entzogen" : ""}
              action={
                gone("mira")
                  ? undefined
                  : {
                      label: "Entziehen",
                      icon: "x",
                      onClick: () => {
                        withdraw("mira")();
                        document.querySelector<HTMLElement>('[aria-label="Person suchen"]')?.focus();
                      },
                    }
              }
            />
          </List>
        </Section>
        <Section icon="search" title="Suche">
          <Input type="search" icon="search" label="Person suchen" />
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

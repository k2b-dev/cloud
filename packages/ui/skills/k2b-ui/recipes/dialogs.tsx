// Recipe: dialogs and toasts on the members of a space. "Einladen" opens a dialog with its fields (a sheet from the
// bottom on the phone) and its own one primary. Removing a member asks first with Dialog.confirm and then answers with
// a toast and "Rückgängig"; sending an invitation again answers with a toast that says whether it worked.
import {
  Bar,
  Button,
  Choice,
  Dialog,
  Field,
  Input,
  List,
  Menu,
  type MenuEntry,
  Pane,
  Row,
  Section,
  Text,
  useToast,
  Workspace,
} from "@k2b/ui/v2";
import { createSignal, For } from "solid-js";

type Member = { id: string; name: string; initials: string; color: string; role: string };
type Invitation = { email: string; sent: string; reachable: boolean };

const members: Member[] = [
  { id: "m1", name: "Jana Petersen", initials: "JP", color: "#2563eb", role: "Verwalten" },
  { id: "m2", name: "Jonas Wolf", initials: "JW", color: "#047857", role: "Bearbeiten" },
  { id: "m3", name: "Mira Aydın", initials: "MA", color: "#c2410c", role: "Bearbeiten" },
  { id: "m4", name: "Tobias Kern", initials: "TK", color: "#7c3aed", role: "Lesen" },
];
const invitations: Invitation[] = [
  { email: "einkauf@stadtwerke-auental", sent: "eingeladen am 18. Nov.", reachable: false },
  { email: "lea.brandt@holzwerk-brandt.de", sent: "eingeladen am 21. Nov.", reachable: true },
];
const roles = ["Lesen", "Bearbeiten", "Verwalten"];

export default function SpaceMembers() {
  const toast = useToast();
  const [list, setList] = createSignal(members);
  const [inviting, setInviting] = createSignal(false);
  const [email, setEmail] = createSignal("");
  const [role, setRole] = createSignal("Bearbeiten");
  const setRoleOf = (member: Member, next: string) =>
    setList(list().map((each) => (each.id === member.id ? { ...each, role: next } : each)));
  const remove = async (member: Member) => {
    const agreed = await Dialog.confirm({
      title: `${member.name} entfernen?`,
      description: `${member.name} sieht die Aufgaben und Dateien dieses Bereichs danach nicht mehr.`,
      confirm: "Entfernen",
    });
    if (!agreed) return;
    const before = list();
    setList(before.filter((each) => each.id !== member.id));
    toast(`${member.name} entfernt`, { undo: () => setList(before) });
  };
  const resend = (invitation: Invitation) =>
    invitation.reachable
      ? toast(`Einladung an ${invitation.email} erneut gesendet`, { status: "ok" })
      : toast(`Einladung an ${invitation.email} nicht gesendet: Die Adresse hat keine Domain.`, { status: "bad" });
  const deeds = (member: Member): MenuEntry[] => [
    { title: "Rolle", choice: member.role, onChoose: (next) => setRoleOf(member, next), items: roles.map((label) => ({ label })) },
    // `void`: a returned Promise would keep the menu open and its entry busy while the question waits
    { label: "Entfernen", icon: "user-minus", danger: true, onClick: () => void remove(member) },
  ];
  const invite = () => {
    setInviting(false);
    toast(`Einladung an ${email() || "die neue Person"} gesendet`, { status: "ok" });
    setEmail("");
  };
  return (
    <Workspace
      primary={{ label: "Einladen", icon: "user-plus", onClick: () => setInviting(true) }}
      head={
        <Bar
          start={<Text type="body">Mitglieder · Werkstatt Nord</Text>}
          end={
            <Button variant="primary" icon="user-plus" onClick={() => setInviting(true)}>
              Einladen
            </Button>
          }
        />
      }
    >
      <Pane label="Mitglieder">
        <Section icon="users" title="Mitglieder" count={list().length}>
          <List label="Mitglieder">
            <For each={list()}>
              {(member) => (
                <Row
                  avatar={{ name: member.name, initials: member.initials, color: member.color }}
                  lines={[member.name, member.role]}
                  end={<Menu label={`Aktionen für ${member.name}`} items={deeds(member)} />}
                />
              )}
            </For>
          </List>
        </Section>
        <Section icon="mail" title="Offene Einladungen" count={invitations.length}>
          <List label="Offene Einladungen">
            <For each={invitations}>
              {(invitation) => (
                <Row
                  icon="mail"
                  lines={[invitation.email, invitation.sent]}
                  action={{ label: "Erneut senden", icon: "send", onClick: () => resend(invitation) }}
                />
              )}
            </For>
          </List>
        </Section>
      </Pane>
      <Dialog
        title="Person einladen"
        open={inviting()}
        onOpenChange={setInviting}
        foot={
          <>
            <Button onClick={() => setInviting(false)}>Abbrechen</Button>
            <Button variant="primary" icon="send" onClick={invite}>
              Einladen
            </Button>
          </>
        }
      >
        <Text>Die Person bekommt eine E-Mail mit einem Link, der sieben Tage gilt.</Text>
        <Field name="email" label="E-Mail-Adresse">
          <Input type="email" value={email()} onInput={setEmail} placeholder="name@beispiel.de" />
        </Field>
        <Field name="role" label="Rolle" hint="Verwalten darf auch Mitglieder einladen und entfernen.">
          <Choice name="role" options={roles} value={role()} onChange={setRole} />
        </Field>
      </Dialog>
    </Workspace>
  );
}

// The states that Fibel's Example offers beside the default. A state with `press` opens an overlay as a person would:
// after the page is live the Example presses the visible buttons and menu entries with these names, one after the other.
export const states = {
  dialog: { render: () => <SpaceMembers />, press: "Einladen" },
  confirm: { render: () => <SpaceMembers />, press: ["Aktionen für Jonas Wolf", "Entfernen"] },
  undo: { render: () => <SpaceMembers />, press: ["Aktionen für Jonas Wolf", "Entfernen", "Entfernen"] },
  error: { render: () => <SpaceMembers />, press: "Erneut senden" },
};

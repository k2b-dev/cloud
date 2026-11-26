// Recipe: dialogs and toasts on the members of a space. "Einladen" opens a dialog with its fields (a sheet from the
// bottom on the phone) and its own one primary. Removing a member asks first with Dialog.confirm and then answers with
// a toast and "Rückgängig"; sending an invitation again answers with a toast that says whether it worked.
import {
  Bar,
  Button,
  Chip,
  Choice,
  Dialog,
  Field,
  Inline,
  Input,
  List,
  Mark,
  Menu,
  type MenuEntry,
  Nav,
  Pane,
  Row,
  Section,
  StatusRow,
  Text,
  useToast,
  Workspace,
} from "@k2b/ui/v2";
import { createSignal, For } from "solid-js";

type Member = { id: string; name: string; initials: string; color: string; role: string };
type Invitation = { email: string; sent: string; reachable: boolean };

// The app this screen belongs to: its colour tints the page and marks it in the host's rail.
export const app = { color: "#4f46e5", icon: "layout-kanban" };

// Each space has its colour and symbol, the same in the sidebar, the head and every sentence.
const space = {
  north: { icon: "tool", color: "#c2410c" },
  office: { icon: "briefcase", color: "#2563eb" },
  fair: { icon: "confetti", color: "#db2777" },
  site: { icon: "building", color: "#0e7490" },
};
const invitationMark = { icon: "mail-forward", color: "#4f46e5" };

const members: Member[] = [
  { id: "m1", name: "Jana Petersen", initials: "JP", color: "#2563eb", role: "Verwalten" },
  { id: "m2", name: "Jonas Wolf", initials: "JW", color: "#047857", role: "Bearbeiten" },
  { id: "m3", name: "Mira Aydın", initials: "MA", color: "#c2410c", role: "Bearbeiten" },
  { id: "m4", name: "Tobias Kern", initials: "TK", color: "#7c3aed", role: "Lesen" },
  { id: "m5", name: "Felix Thal", initials: "FT", color: "#0e7490", role: "Bearbeiten" },
  { id: "m6", name: "Sami Yilmaz", initials: "SY", color: "#a16207", role: "Bearbeiten" },
  { id: "m7", name: "Lena Hartwig", initials: "LH", color: "#db2777", role: "Lesen" },
];
// what each member did here last, so the list says who is active
const last: Record<string, string> = {
  m1: "heute aktiv · 14 Aufgaben",
  m2: "heute aktiv · 9 Aufgaben",
  m3: "gestern · 6 Aufgaben",
  m4: "vor 3 Wochen",
  m5: "heute aktiv · 11 Aufgaben",
  m6: "Mo. · 4 Aufgaben",
  m7: "vor 2 Tagen",
};
const invitations: Invitation[] = [
  { email: "einkauf@stadtwerke-auental", sent: "Adresse ohne Domain · eingeladen am 18. Nov.", reachable: false },
  { email: "lea.brandt@holzwerk-brandt.de", sent: "zugestellt · eingeladen am 21. Nov.", reachable: true },
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
      cancel: "Abbrechen",
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
      sidebar={
        <Nav
          title="Spaces"
          icon="layout-kanban"
          groups={[
            {
              items: [
                { label: "Meine Aufgaben", icon: "checkbox", count: 12, href: "#meine" },
                { label: "Kalender", icon: "calendar", href: "#kalender" },
              ],
            },
            {
              label: "Bereiche",
              items: [
                { label: "Werkstatt Nord", ...space.north, current: true },
                { label: "Büro", ...space.office, count: 3, href: "#buero" },
                { label: "Messe 2027", ...space.fair, href: "#messe" },
                { label: "Baustelle Oswald", ...space.site, dot: "warn", href: "#oswald" },
              ],
            },
          ]}
        />
      }
      head={
        <Bar
          start={
            <Inline>
              <Mark {...space.north} />
              <Text type="lead">Werkstatt Nord</Text>
            </Inline>
          }
          end={
            <Button variant="primary" icon="user-plus" onClick={() => setInviting(true)}>
              Einladen
            </Button>
          }
        />
      }
    >
      <Pane
        label="Mitglieder"
        status={
          <StatusRow
            lead={`${list().length} Mitglieder`}
            facts={[{ value: 3, after: "heute aktiv" }]}
            filters={<Chip status="warn">1 Einladung kommt nicht an</Chip>}
          />
        }
      >
        <Section icon="users" title="Mitglieder" count={list().length}>
          <List label="Mitglieder">
            <For each={list()}>
              {(member) => (
                <Row
                  avatar={{ name: member.name, initials: member.initials, color: member.color }}
                  lines={[member.name, `${member.role} · ${last[member.id] ?? ""}`]}
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
                  mark={invitationMark}
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

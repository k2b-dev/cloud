import { renderToString } from "solid-js/web";
import { Bar, Nav, Pane, Prose, Row, Section, Text, Workspace } from "../src/v2";

// A long page with a place to jump to far down (`#deep`), as a settings or access page with "#groups": a workspace with
// its sidebar and head, one pane, many sections. Only the pane may scroll to the place; the frame stays where it is.
const sections = Array.from({ length: 24 }, (_, index) => `Abschnitt ${index + 1}`);

const Page = () => (
  <Workspace
    sidebar={
      <Nav
        title="Konto"
        icon="user"
        groups={[
          {
            items: [
              { label: "Profil", icon: "user", href: "/me" },
              { label: "Zugang", icon: "key", href: "/me/access", current: true },
              { label: "Sicherheit", icon: "shield", href: "/me/security" },
            ],
          },
        ]}
      />
    }
    head={<Bar start={<Text type="lead">Zugang</Text>} />}
  >
    <Pane label="Zugang">
      {sections.map((title) => (
        <Section title={title}>
          <Row lines={[`${title}: erste Zeile`, "Zweite Zeile"]} />
          <Row lines={[`${title}: dritte Zeile`, "Vierte Zeile"]} />
        </Section>
      ))}
      <Section title="Gruppen">
        <Prose>
          <p id="deep">Alle Gruppen, in denen du Mitglied bist.</p>
        </Prose>
      </Section>
      <Section title="Danach">
        <Row lines={["Ein Abschnitt nach dem Ziel", "damit das Ziel nicht am Ende steht"]} />
      </Section>
    </Pane>
  </Workspace>
);

/** The page as the server sends it. */
export const render = () => renderToString(() => <Page />);

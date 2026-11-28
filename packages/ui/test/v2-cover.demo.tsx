import { Bar, Cover, Pane, Section, Text, Workspace } from "../src/v2";

// The cover of a place's page and of a task below it: a banner that loads, a slim one above a question, one whose
// picture fails, and one without a picture (no band at all). The pictures come from cover.example, which the test
// holds, serves or fails, so it can measure before, while and after a picture arrives.

export const Demo = () => (
  <Workspace head={<Bar start={<Text type="lead">Werkstatt am Markt</Text>} />}>
    <Pane label="Werkstatt am Markt">
      <Cover src="https://cover.example/hof.svg" alt="" />
      <Section title="Heute">
        <Text>Geöffnet bis 18:00</Text>
      </Section>
      <Cover src="https://cover.example/schmal.svg" alt="Der Hof der Werkstatt von oben" slim />
      <Section title="Wie war dein Besuch?">
        <Text>Anonym: Gespeichert werden nur die Sterne und der Kommentar.</Text>
      </Section>
      <Cover src="https://cover.example/kaputt.svg" alt="" />
      <Section title="Ohne Bild">
        <Text>Ein Ort ohne Banner zeigt keinen leeren Streifen.</Text>
      </Section>
      <Cover alt="" />
    </Pane>
  </Workspace>
);

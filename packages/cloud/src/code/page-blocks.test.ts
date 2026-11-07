import { expect, test } from "bun:test";
import { analyzeCode } from "./checker-analysis";
import { generateCodeSdk } from "./generator";

const sdk = generateCodeSdk([], { mode: "personal" });
const imports = "app, jsx, Page, Section, Text, Stats, Stat, Table, Column, Detail, Item, Form, Field, Option";
const childErrors = (page: string, header = `import { ${imports} } from "@sdk";`) =>
  analyzeCode({
    sdk,
    entry: "code.tsx",
    aiOperations: [],
    files: { "code.tsx": `${header}\nconst names = ["a", "b"];\napp.get("/", c => c.page(<Page title="P">${page}</Page>));` },
  }).diagnostics.filter((diagnostic) => diagnostic.code === "code_page_child");

test("blocks with parts take only their parts, and parts sit only in their block", () => {
  for (const page of [
    '<Form title="F" action="/x" submit="Go"><Text>Not a field</Text></Form>',
    '<Field.Text name="a" label="A" />',
    '<Section title="S"><Stat label="S" value={1} /></Section>',
    '<Stats><Column key="a" label="A" /></Stats>',
    '<Table title="T" rows={[]}><Item label="L" value="V" /></Table>',
    '<Detail title="D"><Stat label="S" value={1} /></Detail>',
    '<Form title="F" action="/x" submit="Go"><Field.Select name="s" label="S"><Field.Text name="t" label="T" /></Field.Select></Form>',
    '<Form title="F" action="/x" submit="Go"><Option value="v" label="V" /></Form>',
    '<Table title="T" rows={[]}>loose text</Table>',
  ])
    expect(childErrors(page).length, page).toBeGreaterThan(0);
});

test("parts in their block pass, also when mapped from data or imported under another name", () => {
  for (const page of [
    '<Form title="F" action="/x" submit="Go"><Field.Text name="a" label="A" /><Field.Select name="s" label="S"><Option value="v" label="V" /></Field.Select></Form>',
    '<Form title="F" action="/x" submit="Go">{names.map(name => <Field.Text name={name} label={name} />)}</Form>',
    '<Stats><Stat label="S" value={1} /><Stat label="T" value={null} /></Stats>',
    '<Table title="T" rows={[]}>{names.map(name => <Column key={name} label={name} />)}</Table>',
    '<Detail title="D"><Item label="L" value="V" /></Detail>',
    '<Section title="S"><Text>Text may sit in a section</Text></Section>',
  ])
    expect(childErrors(page), page).toEqual([]);
  const aliased = `import { app, jsx, Page, Text, Form as Entry } from "@sdk";`;
  expect(childErrors('<Entry title="F" action="/x" submit="Go"><Text>Not a field</Text></Entry>', aliased)).toHaveLength(1);
});

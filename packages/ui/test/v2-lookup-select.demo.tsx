import { createSignal } from "solid-js";
import { isServer } from "solid-js/web";
import { Band, Bar, Field, LookupSelect, Pane, Text, Workspace } from "../src/v2";
import type { LookupItem } from "../src/v2/list-query";

// A form that picks a customer (one, named on the server), contact people (several) and a required consignor from values that
// load while the person types. Every load waits for the test (`window.__picks`), so a test decides when it answers,
// fails or is aborted.

const CUSTOMERS: readonly LookupItem[] = [
  { value: "k-17", label: "Familie Oswald", meta: "Freiburg" },
  { value: "k-23", label: "Architekturbüro Winter", meta: "Lahr" },
  { value: "k-31", label: "Stadtwerke Auental", meta: "Kehl" },
  { value: "k-44", label: "Haus Bergmann", meta: "Offenburg" },
  { value: "k-58", label: "Bergmann & Söhne", meta: "Emmendingen" },
];

type Pending = { resolve: () => void; reject: () => void };
declare global {
  interface Window {
    __picks?: { calls: { query: string; aborted: () => boolean }[]; answer: () => void; fail: () => void; changes: string[] };
  }
}
const pending: Pending[] = [];
const hooks = () => {
  if (isServer) return undefined;
  window.__picks ??= { calls: [], answer: () => pending.shift()?.resolve(), fail: () => pending.shift()?.reject(), changes: [] };
  return window.__picks;
};

const load = (query: string, context: { signal: AbortSignal; limit: number }) =>
  new Promise<{ items: readonly LookupItem[] }>((resolve, reject) => {
    hooks()?.calls.push({ query, aborted: () => context.signal.aborted });
    const entry: Pending = {
      resolve: () =>
        resolve({ items: CUSTOMERS.filter((item) => item.label.toLowerCase().includes(query.toLowerCase())).slice(0, context.limit) }),
      reject: () => reject(new Error("offline")),
    };
    context.signal.addEventListener("abort", () => {
      const index = pending.indexOf(entry);
      if (index >= 0) pending.splice(index, 1);
    });
    pending.push(entry);
  });

export function Demo() {
  const [customer, setCustomer] = createSignal<string | undefined>("k-17");
  const [people, setPeople] = createSignal<string[]>([]);
  const [consignor, setConsignor] = createSignal<string | undefined>();
  return (
    <Workspace head={<Bar start={<Text type="body">Neuer Auftrag</Text>} />}>
      <Pane label="Neuer Auftrag">
        <Band>
          <Field.Row>
            <Field name="customer" label="Kunde">
              <LookupSelect
                value={customer()}
                onChange={(value) => {
                  hooks()?.changes.push(`customer=${value ?? ""}`);
                  setCustomer(value);
                }}
                load={load}
                known={[CUSTOMERS[0]!]}
                placeholder="Kunde wählen"
              />
            </Field>
            <Field name="people" label="Ansprechpersonen" optional="optional">
              <LookupSelect
                multiple
                value={people()}
                onChange={(value) => {
                  hooks()?.changes.push(`people=${value.join(",")}`);
                  setPeople(value);
                }}
                load={load}
                placeholder="Personen wählen"
              />
            </Field>
          </Field.Row>
          <Field name="consignor" label="Einlieferer" required>
            <LookupSelect
              value={consignor()}
              onChange={(value) => {
                hooks()?.changes.push(`consignor=${value ?? ""}`);
                setConsignor(value);
              }}
              load={load}
              placeholder="Einlieferer wählen"
            />
          </Field>
        </Band>
      </Pane>
    </Workspace>
  );
}

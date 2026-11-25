import { createSignal } from "solid-js";
import { isServer } from "solid-js/web";
import { Band, Bar, Field, Input, LookupSelect, Pane, Text, Workspace } from "../src/v2";
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

type Pending = { resolve: (rename?: string) => void; reject: () => void };
declare global {
  interface Window {
    __picks?: {
      calls: { query: string; aborted: () => boolean }[];
      /** Answers the oldest live search; `rename` gives every match that name, as a renamed record would. */
      answer: (rename?: string) => void;
      fail: () => void;
      /** Answers the oldest search that was aborted, late, as a slow server would. */
      answerStale: (rename?: string) => void;
      changes: string[];
      /** Sets the quantity from outside, as the app would. */
      setQuantity?: (value: string) => void;
    };
  }
}
const pending: Pending[] = [];
const stale: Pending[] = [];
const hooks = () => {
  if (isServer) return undefined;
  window.__picks ??= {
    calls: [],
    answer: (rename) => pending.shift()?.resolve(rename),
    fail: () => pending.shift()?.reject(),
    answerStale: (rename) => stale.shift()?.resolve(rename),
    changes: [],
  };
  return window.__picks;
};

const load = (query: string, context: { signal: AbortSignal; limit: number }) =>
  new Promise<{ items: readonly LookupItem[] }>((resolve, reject) => {
    hooks()?.calls.push({ query, aborted: () => context.signal.aborted });
    const entry: Pending = {
      resolve: (rename) =>
        resolve({
          items: CUSTOMERS.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()))
            .slice(0, context.limit)
            .map((item) => (rename ? { ...item, label: rename } : item)),
        }),
      reject: () => reject(new Error("offline")),
    };
    context.signal.addEventListener("abort", () => {
      const index = pending.indexOf(entry);
      if (index >= 0) stale.push(...pending.splice(index, 1));
    });
    pending.push(entry);
  });

export function Demo() {
  const [customer, setCustomer] = createSignal<string | undefined>("k-17");
  const [people, setPeople] = createSignal<string[]>([]);
  const [consignor, setConsignor] = createSignal<string | undefined>();
  // `?quantity=` starts the field with another value (the browser only; the server renders 1500)
  const [quantity, setQuantity] = createSignal((isServer ? null : new URLSearchParams(location.search).get("quantity")) ?? "1500");
  const picks = hooks();
  if (picks) picks.setQuantity = setQuantity;
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
          {/* a number in the locale of the page, without a spinner */}
          <Field name="quantity" label="Menge" optional="Stück">
            <Input
              type="number"
              min={1}
              value={quantity()}
              onInput={(value) => {
                hooks()?.changes.push(`quantity=${value}`);
                setQuantity(value);
              }}
            />
          </Field>
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
          {/* disabled fields: never sent, and a required one does not hold the form back */}
          <Field.Row>
            <Field name="agent" label="Vertretung" required>
              <LookupSelect disabled value={undefined} onChange={() => undefined} load={load} placeholder="Nur mit Vollmacht" />
            </Field>
            <Field name="store" label="Lager">
              <LookupSelect disabled multiple value={["k-31"]} onChange={() => undefined} load={load} known={[CUSTOMERS[2]!]} />
            </Field>
            <Field name="slots" label="Lagerplätze">
              <Input type="number" disabled value="3" />
            </Field>
          </Field.Row>
        </Band>
      </Pane>
    </Workspace>
  );
}

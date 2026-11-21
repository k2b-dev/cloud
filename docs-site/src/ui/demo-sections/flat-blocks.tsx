import {
  Area,
  Button,
  DataTable,
  FactGroup,
  FieldGrid,
  FileName,
  NoticeCard,
  NoticeRow,
  NumberInput,
  Placeholder,
  RowGroup,
  Section,
  StatusBadge,
  TextInput,
} from "@k2b/ui";
import { For } from "solid-js";
import { DemoCard } from "../DemoCard";

/** All names, numbers, and places on this page are invented. */
const lists = (...numbers: string[]) => (
  <For each={numbers}>
    {(number) => (
      <div class="ui-flat-demo-row">
        <b>{number}</b>
        <span>All items captured · photographed</span>
      </div>
    )}
  </For>
);

/** K17: the two levels below a section, the group and the area, in every state. */
export const GroupAreaDemo = () => (
  <DemoCard
    id="group-area"
    chip={[
      { kind: "component", name: "RowGroup", from: "@k2b/ui" },
      { kind: "component", name: "Area", from: "@k2b/ui" },
    ]}
    description="A group sorts the rows of one list and disappears when it is empty. An area is a thing the rows hang on: open it has a 56 px head and a rail, closed it is one 40 px row, and an empty area says so. Opening or closing moves only what lies below its head."
    code={`<Section size="md" icon="ti ti-stack-2" iconColor="#4f46e5" title="Stacks and lists" count={3}>
  <Area name="Stack 1" marker={1} collapsible meta="2 lists · 2 of 2 photographed"
    state={<StatusBadge tone="ok" label="All lists in" />}
    actions={<Button size="sm" variant="secondary">Reopen</Button>}>…</Area>
  <Area name="Stack 2" marker={2} collapsible defaultOpen={false} count={1}
    state={<StatusBadge tone="warning" label="Open" />}>…</Area>
  <Area name="Stack 3" marker={3} collapsible empty="No list yet"
    actions={<Button size="sm" variant="secondary">Close without a list</Button>} />
</Section>
<RowGroup title="Open" count={2}>…</RowGroup>
<RowGroup title="Done" count={0} />`}
  >
    <div class="ui-flat-demo-stack">
      <Section size="md" icon="ti ti-stack-2" iconColor="#4f46e5" title="Stacks and lists" count={3}>
        <Area
          name="Stack 1"
          marker={1}
          collapsible
          meta="2 lists · 2 of 2 photographed"
          state={<StatusBadge tone="ok" label="All lists in" />}
          actions={
            <Button size="sm" variant="secondary">
              Reopen
            </Button>
          }
        >
          {lists("L-1001", "L-1002")}
          <Area name="Stack 1a" marker="1a" meta="Split off on 11 Nov" state={<StatusBadge tone="neutral" label="Waiting" />}>
            {lists("L-1007")}
          </Area>
        </Area>
        <Area name="Stack 2" marker={2} collapsible defaultOpen={false} count={1} state={<StatusBadge tone="warning" label="Open" />}>
          {lists("L-1003")}
        </Area>
        <Area
          name="Stack 3"
          marker={3}
          collapsible
          empty="No list yet. Enter the number from the slip."
          state={<StatusBadge tone="warning" label="Open" />}
          actions={
            <Button size="sm" variant="secondary">
              Close without a list
            </Button>
          }
        />
      </Section>
      <div>
        <RowGroup
          title="Open"
          count={2}
          action={
            <Button size="sm" variant="ghost">
              Add
            </Button>
          }
        >
          <div class="ui-flat-demo-row">Call the carrier about the pickup</div>
          <div class="ui-flat-demo-row">Print labels for stack 2</div>
        </RowGroup>
        <RowGroup title="Done" count={0} />
        <RowGroup title="Waiting" count={1}>
          <div class="ui-flat-demo-row">Signature on the receipt</div>
        </RowGroup>
      </div>
    </div>
  </DemoCard>
);

/** K17: the quiet fact column and K5: a row of fields on one grid. */
export const FactsFieldsDemo = () => (
  <DemoCard
    id="facts-fields"
    chip={[
      { kind: "component", name: "FactGroup", from: "@k2b/ui" },
      { kind: "component", name: "FieldGrid", from: "@k2b/ui" },
    ]}
    description="Facts: label quiet, value strong, one pencil per group, copy at values people carry elsewhere; in a column under 360 px the label stands above its value. Fields: a 20 px label row, the control, help or error below it, so the controls of a row share their top edge; under 360 px they stack."
    code={`<FactGroup title="Contact" icon="ti ti-phone" onEdit={edit} items={[
  { label: "Phone", value: "+49 30 2312 5173", detail: "Default", copy: true },
  { label: "Email", value: "h.vossberg@example.test", copy: true },
]} />
<FieldGrid columns={3}>
  <TextInput label="Place" description="Shelf and row, as on the label" value="B 4" />
  <NumberInput label="Daily rate" error="Enter an amount." value={null} />
  <TextInput label="Code" value="Q92" />
</FieldGrid>`}
  >
    <div class="ui-flat-demo-stack">
      <div class="ui-flat-demo-column">
        <FactGroup
          title="Contact"
          icon="ti ti-phone"
          onEdit={() => {}}
          items={[
            { label: "Phone", value: "+49 30 2312 5173", detail: "Default", copy: true },
            { label: "Email", value: "h.vossberg@example.test", copy: true },
            { label: "Address", value: "Lindenweg 8, 12345 Musterstadt", copy: true },
          ]}
        />
        <FactGroup
          title="Bank"
          icon="ti ti-building-bank"
          onEdit={() => {}}
          items={[
            { label: "IBAN", value: "DE00 1234 5678 9012 3456 78", copy: true },
            { label: "Holder", value: "Henrike Vossberg" },
          ]}
        />
      </div>
      <div class="ui-flat-demo-fields">
        <FieldGrid columns={3}>
          <TextInput label="Place" description="Shelf and row, as on the label" value="B 4" />
          <NumberInput label="Daily rate" error="Enter an amount." value={null} />
          <TextInput label="Code" value="Q92" />
        </FieldGrid>
        <div class="ui-flat-demo-narrow">
          <FieldGrid>
            <TextInput label="From" value="10 Nov" />
            <TextInput label="To" value="14 Nov" />
          </FieldGrid>
        </div>
      </div>
    </div>
  </DemoCard>
);

const tableRows = [
  { name: "Oak cabinet with two drawers", place: "Shelf B 4", owner: "Mira Solberg", amount: 1240, file: "Appraisal oak cabinet 2026.pdf" },
  { name: "Brass lamp", place: "Shelf A 1", owner: "Jonte Kramer", amount: 85.5, file: "brass-lamp.jpeg" },
  { name: "Set of six chairs", place: "Hall 2", owner: "Mira Solberg", amount: 640, file: "chairs.heic" },
];

/** K7, K15: the flat table, its group rows, the name column, file names, and the list on a phone. */
export const FlatTableDemo = () => (
  <DemoCard
    id="flat-table"
    chip={[
      { kind: "component", name: "DataTable", from: "@k2b/ui" },
      { kind: "component", name: "FileName", from: "@k2b/ui" },
    ]}
    description="A 36 px head without fill, hairlines only under the rows, 40 px rows, amounts right-aligned and whole. The name column is marked primary; file names shorten before their ending. Below 480 px of width the table is a list of two-line entries."
    code={`const columns = [
  { id: "name", header: "Item", value: "name", primary: true, list: "title" },
  { id: "place", header: "Place", value: "place", list: "meta" },
  { id: "file", header: "File", value: "file" },
  { id: "amount", header: "Estimate", value: "amount", type: "amount", format: { currency: "EUR" }, list: "end" },
];
<DataTable columns={columns} rows={rows} groupBy="owner" collapsibleGroups renderCell={…FileName…} surface="plain" />`}
  >
    <div class="ui-flat-demo-stack">
      <DataTable
        surface="plain"
        ariaLabel="Items by owner"
        rows={tableRows}
        groupBy="owner"
        collapsibleGroups
        getRowId={(row) => row.name}
        selectedRowId="Brass lamp"
        columns={[
          { id: "name", header: "Item", value: "name", primary: true, list: "title" },
          { id: "place", header: "Place", value: "place", list: "meta" },
          { id: "owner", header: "Owner", value: "owner", priority: 3 },
          { id: "file", header: "File", value: "file", priority: 2 },
          { id: "amount", header: "Estimate", value: "amount", type: "amount", format: { currency: "EUR" }, list: "end" },
        ]}
        renderCell={({ col, value, render }) => (col.id === "file" ? <FileName name={String(value)} /> : render(value))}
      />
      <div class="ui-flat-demo-narrow">
        <DataTable
          surface="plain"
          ariaLabel="Items as a list"
          rows={tableRows}
          columns={[
            { id: "name", header: "Item", value: "name", primary: true, list: "title" },
            { id: "place", header: "Place", value: "place", list: "meta" },
            { id: "amount", header: "Estimate", value: "amount", type: "amount", format: { currency: "EUR" }, list: "end" },
          ]}
        />
      </div>
    </div>
  </DemoCard>
);

/** K10, K14: the alert cell in its four tones, with and without a deed, wide and narrow. */
export const AlertCellDemo = () => (
  <DemoCard
    id="alert-cell"
    chip={[
      { kind: "component", name: "NoticeCard", from: "@k2b/ui" },
      { kind: "component", name: "NoticeRow", from: "@k2b/ui" },
    ]}
    description="When something needs a person, the whole square cell carries the tint: a sign, a sentence, its consequence, and one button that names the deed. In a narrow cell the button moves under the text. There is no frame around it."
    code={`<NoticeCard tone="yours" icon="ti ti-signature" title="The receipt waits for a signature."
  detail="QU-2611-00021 · Payout starts after it is signed."
  actions={<Button size="sm" variant="secondary">Open receipt</Button>} />`}
  >
    <div class="ui-flat-demo-cells">
      <NoticeCard
        tone="yours"
        icon="ti ti-signature"
        title="The receipt waits for a signature."
        detail="QU-2611-00021 · Payout starts after it is signed."
        actions={
          <Button size="sm" variant="secondary">
            Open receipt
          </Button>
        }
      />
      <NoticeCard
        tone="danger"
        icon
        title="The reply at 09:44 was not sent."
        detail="The text is still in the composer."
        actions={
          <Button size="sm" variant="secondary">
            Send again
          </Button>
        }
      />
      <NoticeCard tone="info" icon title="3 unsold items are ready for pickup." detail="Until 12 Dec 2026." />
      <NoticeCard tone="success" icon title="All lists are in." detail="Stack 1 was closed by Lisa Quittung." />
      <Placeholder tone="success" title="All done" description="Nothing waits for you in this space." />
      <NoticeRow
        tone="neutral"
        tile="ti ti-photo-shield"
        action={
          <Button size="sm" variant="secondary">
            Load images
          </Button>
        }
      >
        External images are blocked in this mail.
      </NoticeRow>
      <div class="ui-flat-demo-narrow">
        <NoticeCard
          tone="warning"
          icon
          title="The receipt waits for a signature."
          detail="Payout starts after it is signed."
          actions={
            <Button size="sm" variant="secondary">
              Open receipt
            </Button>
          }
        />
      </div>
    </div>
  </DemoCard>
);

import { LocaleProvider } from "@k2b/ui";
import { onMount } from "solid-js";
import { RecordCardsView } from "../../src/frontend/_components/records-view/RecordCardsView";
import { RecordsAdminToolbar } from "../../src/frontend/_components/records-view/RecordsAdminToolbar";
import { fields, records } from "../../src/frontend/_components/table/database-table.fixture-data";

/** A card view in edit mode for someone who manages the table; choosing a field records it on the body. */
export default function RecordsFieldsMenuFixture() {
  const noop = () => {};
  // Tells the browser test that the island hydrated and its controls respond.
  onMount(() => {
    document.body.dataset.fixtureReady = "true";
  });
  return (
    <LocaleProvider locale="de">
      <div class="flex min-h-0 flex-1 flex-col gap-2">
        <RecordsAdminToolbar
          savedView={false}
          activeViewAvailable={false}
          canEditActiveView={false}
          hiddenViewColumnCount={0}
          allowForms
          formsButtonLabel="Formulare"
          tableFields={fields}
          onFieldSettings={(field) => {
            document.body.dataset.fieldSettings = field.id;
          }}
          onOpenTableSettings={noop}
          onAddField={noop}
          onOpenForms={noop}
          onOpenTemplates={noop}
          onOpenViewSettings={noop}
          onAddViewColumn={noop}
          onDone={noop}
        />
        <RecordCardsView items={records.slice(0, 4)} fields={fields} displayConfig={{ mode: "cards" }} baseId="base" tableId="table" />
      </div>
    </LocaleProvider>
  );
}

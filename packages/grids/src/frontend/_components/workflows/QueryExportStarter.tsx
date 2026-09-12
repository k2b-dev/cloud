import { i18n } from "@k2b/stdlib";
import { Button, DetailPanel, NoticeCard, Select, TextInput, useLocale } from "@k2b/ui";
import { createSignal, For, Index, onCleanup, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { PublicDslQueryPreviewResponse } from "../../../api/gql-public";
import type { PublicField, PublicTable } from "../../../api/public-dto";
import { resolveWorkflowQueryParameters, WorkflowQueryParametersSchema } from "../../../workflows/query-parameters";
import { GqlSourceEditor } from "../query/GqlSourceEditor";
import QueryResultTable from "../query/QueryResultTable";
import { errorMessage } from "../utils/api-helpers";
import { type FreeQueryOutput, type QueryExportInput, queryExportWorkflowSource } from "./query-export-workflow-source";
import type { WorkflowStarter } from "./workflow-starters";

export const queryExportMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: "Create a file from a query",
      hint: "Choose the data and columns with GQL, then create a PDF, CSV, JSON or XML workflow.",
      query: "GQL query",
      parameters: "Run inputs",
      parametersHint:
        "Add values to ask for when the workflow runs. Use @params.name in the query. Preview values are not saved in the workflow.",
      addParameter: "Add input",
      parameterName: "Parameter name",
      parameterType: "Type",
      sample: "Preview value",
      yes: "Yes",
      no: "No",
      decimalHint: "Use a decimal point, for example 12.30. Do not use thousands separators.",
      dateHint: "Use YYYY-MM-DD.",
      dateTimeHint: "Use ISO date and time with a time zone, for example 2026-09-12T09:00:00+02:00.",
      removeParameter: "Remove input",
      parameterInvalid:
        "Check the input names and preview values. Names must be unique, start with a lowercase letter and contain only lowercase letters, numbers or underscores.",
      preview: "Preview data",
      previewHint:
        "This is a live sample, not the export snapshot. The workflow captures the complete query result when it runs, within the export limits.",
      previewFailed: "Could not preview the query. Check the query and try again.",
      next: "Choose file format",
      back: "Edit query",
      name: "Workflow name",
      format: "File format",
      body: "Template",
      templateHint:
        "Use rows and columns from the query. Access a value with row[column.key]. HTML and XML values are escaped automatically; do not add an escape filter.",
      delimiter: "CSV delimiter",
      comma: "Comma",
      semicolon: "Semicolon",
      tab: "Tab",
      pipe: "Pipe (|)",
      advanced: "More output options",
      nested: "Nested CSV values",
      reject: "Reject nested values",
      nestedJson: "Serialize as JSON",
      protection: "Spreadsheet text protection",
      protected: "Enabled (recommended)",
      raw: "Raw text",
      rawWarning:
        "Spreadsheet applications may interpret raw text as formulas. Use raw text only for trusted destinations that require it.",
      rowsKey: "JSON rows key (optional)",
      rowsKeyHint: "Leave empty for an array. Enter a key such as rows to wrap the array in an object.",
      header: "PDF header",
      footer: "PDF footer",
      css: "PDF styles (CSS)",
      csvHint: "Column aliases become headers. By default, spreadsheet text protection is enabled and nested values are rejected.",
      jsonHint: "Exports an array of rows with column aliases as keys. Exact decimals remain strings, without rounding.",
      review: "Review workflow",
      reviewHint: "Creates a disabled draft in the workflow editor. Review the source and permissions before enabling it.",
    },
    de: {
      title: "Datei aus einer Abfrage erstellen",
      hint: "Daten und Spalten mit GQL auswählen, danach einen Workflow für PDF, CSV, JSON oder XML erstellen.",
      query: "GQL-Abfrage",
      parameters: "Eingaben beim Start",
      parametersHint:
        "Lege Werte fest, die beim Workflow-Start abgefragt werden. Nutze @params.name in der Abfrage. Vorschauwerte werden nicht im Workflow gespeichert.",
      addParameter: "Eingabe hinzufügen",
      parameterName: "Parametername",
      parameterType: "Typ",
      sample: "Vorschauwert",
      yes: "Ja",
      no: "Nein",
      decimalHint: "Nutze einen Dezimalpunkt, zum Beispiel 12.30. Keine Tausendertrennzeichen.",
      dateHint: "Nutze JJJJ-MM-TT.",
      dateTimeHint: "Nutze ISO-Datum und Uhrzeit mit Zeitzone, zum Beispiel 2026-09-12T09:00:00+02:00.",
      removeParameter: "Eingabe entfernen",
      parameterInvalid:
        "Prüfe Namen und Vorschauwerte. Namen müssen eindeutig sein, mit einem Kleinbuchstaben beginnen und dürfen nur Kleinbuchstaben, Zahlen oder Unterstriche enthalten.",
      preview: "Daten prüfen",
      previewHint:
        "Dies ist eine aktuelle Stichprobe, noch kein Export-Snapshot. Der Workflow erfasst beim Ausführen das vollständige Abfrageergebnis innerhalb der Exportgrenzen.",
      previewFailed: "Die Vorschau konnte nicht geladen werden. Prüfe die Abfrage und versuche es erneut.",
      next: "Dateiformat wählen",
      back: "Abfrage bearbeiten",
      name: "Workflow-Name",
      format: "Dateiformat",
      body: "Vorlage",
      templateHint:
        "Nutze rows und columns aus der Abfrage. Ein Wert ist über row[column.key] erreichbar. HTML- und XML-Werte werden automatisch maskiert; ergänze keinen escape-Filter.",
      delimiter: "CSV-Trennzeichen",
      comma: "Komma",
      semicolon: "Semikolon",
      tab: "Tabulator",
      pipe: "Senkrechter Strich (|)",
      advanced: "Weitere Ausgabeoptionen",
      nested: "Verschachtelte CSV-Werte",
      reject: "Verschachtelte Werte ablehnen",
      nestedJson: "Als JSON ausgeben",
      protection: "Schutz vor Tabellenformeln",
      protected: "Aktiv (empfohlen)",
      raw: "Unveränderter Text",
      rawWarning:
        "Tabellenprogramme können unveränderten Text als Formeln interpretieren. Nutze diese Option nur für vertrauenswürdige Ziele, die sie benötigen.",
      rowsKey: "JSON-Zeilenschlüssel (optional)",
      rowsKeyHint: "Leer lassen für eine Liste. Ein Schlüssel wie rows bettet die Liste in ein Objekt ein.",
      header: "PDF-Kopfzeile",
      footer: "PDF-Fußzeile",
      css: "PDF-Gestaltung (CSS)",
      csvHint:
        "Spaltenaliase werden zu Überschriften. Standardmäßig ist der Schutz vor Tabellenformeln aktiv und verschachtelte Werte werden abgelehnt.",
      jsonHint:
        "Exportiert eine Liste von Zeilen mit Spaltenaliasen als Schlüsseln. Exakte Dezimalwerte bleiben Zeichenketten, ohne Rundung.",
      review: "Workflow prüfen",
      reviewHint: "Öffnet einen deaktivierten Entwurf im Workflow-Editor. Prüfe Quelle und Berechtigungen vor dem Aktivieren.",
    },
  },
});

export const queryExportTemplates = {
  pdf: "<table><thead><tr>{% for column in columns %}<th>{{ column.label }}</th>{% endfor %}</tr></thead><tbody>{% for row in rows %}<tr>{% for column in columns %}<td>{{ row[column.key] }}</td>{% endfor %}</tr>{% endfor %}</tbody></table>",
  xml: '<report>{% for row in rows %}<row>{% for column in columns %}<value name="{{ column.label }}">{{ row[column.key] }}</value>{% endfor %}</row>{% endfor %}</report>',
};

export function QueryExportStarter(props: {
  baseId: string;
  tables: PublicTable[];
  fieldsByTable: Record<string, PublicField[]>;
  onDirty: () => void;
  onComplete: (starter: WorkflowStarter) => void;
}) {
  const locale = useLocale();
  const t = () => queryExportMessages.resolve([locale()]).t;
  const firstTable = props.tables[0];
  const [source, setSource] = createSignal(firstTable ? `from table {${firstTable.id}}` : "");
  const [preview, setPreview] = createSignal<PublicDslQueryPreviewResponse>();
  const [previewCursor, setPreviewCursor] = createSignal<string>();
  const [loading, setLoading] = createSignal(false);
  const [failure, setFailure] = createSignal("");
  const [step, setStep] = createSignal<"query" | "output">("query");
  const [name, setName] = createSignal(t().title);
  const [format, setFormat] = createSignal<FreeQueryOutput["kind"]>("csv");
  const [delimiter, setDelimiter] = createSignal<"," | ";" | "\t" | "|">(",");
  const [nestedValues, setNestedValues] = createSignal<"reject" | "json">("reject");
  const [textProtection, setTextProtection] = createSignal<"spreadsheet" | "raw">("spreadsheet");
  const [rowsKey, setRowsKey] = createSignal("");
  const [header, setHeader] = createSignal("");
  const [footer, setFooter] = createSignal("");
  const [css, setCss] = createSignal("");
  const [pdf, setPdf] = createSignal(queryExportTemplates.pdf);
  const [xml, setXml] = createSignal(queryExportTemplates.xml);
  type InputDraft = QueryExportInput & { id: number; sample: string };
  const [inputs, setInputs] = createSignal<InputDraft[]>([]);
  let nextInputId = 0;
  let request: AbortController | undefined;
  const cancel = () => {
    request?.abort();
    request = undefined;
    setLoading(false);
  };
  onCleanup(cancel);
  const editQuery = (value: string) => {
    cancel();
    setSource(value);
    setPreview(undefined);
    setPreviewCursor(undefined);
    setFailure("");
    props.onDirty();
  };
  const changeInputs = (next: InputDraft[]) => {
    setInputs(next);
    editQuery(source());
  };
  const parameterTypes: QueryExportInput["type"][] = ["text", "number", "decimal", "boolean", "date", "dateTime"];
  const loadPreview = async (cursor?: string) => {
    cancel();
    const controller = new AbortController();
    request = controller;
    setLoading(true);
    setFailure("");
    try {
      const entries = inputs().map(
        (input) =>
          [
            input.name,
            {
              type: input.type,
              value:
                input.type === "number"
                  ? input.sample.trim()
                    ? Number(input.sample)
                    : null
                  : input.type === "boolean"
                    ? input.sample === "true"
                      ? true
                      : input.sample === "false"
                        ? false
                        : null
                    : input.sample,
            },
          ] as const,
      );
      const parsed = WorkflowQueryParametersSchema.safeParse(Object.fromEntries(entries));
      if (new Set(inputs().map((input) => input.name)).size !== inputs().length || !parsed.success) throw new Error(t().parameterInvalid);
      const bound = await resolveWorkflowQueryParameters(parsed.data, async () => {
        throw new Error(t().parameterInvalid);
      });
      if (!bound.ok) throw new Error(t().parameterInvalid);
      if (request !== controller) return;
      const parameters = Object.fromEntries(
        Object.entries(bound.values).map(([key, value]) => {
          const name = key.slice("params.".length);
          if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
            return [name, value] as const;
          if (value && "decimal" in value) return [name, { decimal: value.decimal }] as const;
          throw new Error(t().parameterInvalid);
        }),
      );
      const response = await apiClient.gql["by-base"][":baseId"].execute.$post(
        { param: { baseId: props.baseId }, json: { query: source(), pageSize: 100, parameters, ...(cursor ? { cursor } : {}) } },
        { init: { signal: controller.signal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, t().previewFailed));
      const result = await response.json();
      if (request === controller) {
        setPreview(result);
        setPreviewCursor(result.ok ? cursor : undefined);
      }
    } catch (error) {
      if (request === controller && !controller.signal.aborted) {
        setPreview(undefined);
        setFailure(error instanceof Error ? error.message : t().previewFailed);
      }
    } finally {
      if (request === controller) {
        request = undefined;
        setLoading(false);
      }
    }
  };
  const result = () => {
    const value = preview();
    return value?.ok ? value : undefined;
  };
  const diagnostics = () => {
    const value = preview();
    return value && !value.ok ? value.diagnostics : [];
  };
  const output = (): FreeQueryOutput => {
    switch (format()) {
      case "pdf":
        return {
          kind: "pdf",
          body: pdf(),
          header: header().trim() || undefined,
          footer: footer().trim() || undefined,
          css: css().trim() || undefined,
        };
      case "xml":
        return { kind: "xml", body: xml() };
      case "json":
        return { kind: "json", ...(rowsKey().trim() ? { wrapper: { rowsKey: rowsKey().trim() } } : {}) };
      default:
        return { kind: "csv", delimiter: delimiter(), nestedValues: nestedValues(), textProtection: textProtection() };
    }
  };
  return (
    <div class="flex min-w-0 flex-col gap-4">
      <Show
        when={step() === "query"}
        fallback={
          <>
            <Button variant="ghost" class="self-start" onClick={() => setStep("query")}>
              <i class="ti ti-arrow-left" />
              {t().back}
            </Button>
            <TextInput
              label={t().name}
              value={name}
              onValueChange={(value) => {
                setName(value);
                props.onDirty();
              }}
              required
            />
            <Select
              label={t().format}
              value={format}
              options={(["csv", "json", "pdf", "xml"] as const).map((id) => ({ id, label: id.toUpperCase() }))}
              onValueChange={(value) => {
                if (value === "csv" || value === "json" || value === "pdf" || value === "xml") {
                  setFormat(value);
                  props.onDirty();
                }
              }}
            />
            <Show when={format() === "csv"}>
              <Select
                label={t().delimiter}
                value={delimiter}
                options={[
                  { id: ",", label: t().comma },
                  { id: ";", label: t().semicolon },
                  { id: "\t", label: t().tab },
                  { id: "|", label: t().pipe },
                ]}
                onValueChange={(value) => {
                  if (value === "," || value === ";" || value === "\t" || value === "|") {
                    setDelimiter(value);
                    props.onDirty();
                  }
                }}
              />
              <p class="text-sm text-dimmed">{t().csvHint}</p>
            </Show>
            <Show when={format() === "json"}>
              <p class="text-sm text-dimmed">{t().jsonHint}</p>
            </Show>
            <Show when={format() === "pdf" || format() === "xml"}>
              <TextInput
                label={t().body}
                description={t().templateHint}
                value={() => (format() === "pdf" ? pdf() : xml())}
                onValueChange={(value) => {
                  (format() === "pdf" ? setPdf : setXml)(value);
                  props.onDirty();
                }}
                multiline
                lines={8}
                required
              />
            </Show>
            <Show when={format() !== "xml"}>
              <DetailPanel.Section title={t().advanced} collapsible>
                <div class="flex flex-col gap-3">
                  <Show when={format() === "csv"}>
                    <Select
                      label={t().nested}
                      value={nestedValues}
                      options={[
                        { id: "reject", label: t().reject },
                        { id: "json", label: t().nestedJson },
                      ]}
                      onValueChange={(value) => {
                        if (value === "reject" || value === "json") {
                          setNestedValues(value);
                          props.onDirty();
                        }
                      }}
                    />
                    <Select
                      label={t().protection}
                      value={textProtection}
                      options={[
                        { id: "spreadsheet", label: t().protected },
                        { id: "raw", label: t().raw },
                      ]}
                      onValueChange={(value) => {
                        if (value === "spreadsheet" || value === "raw") {
                          setTextProtection(value);
                          props.onDirty();
                        }
                      }}
                    />
                    <Show when={textProtection() === "raw"}>
                      <NoticeCard tone="warning">{t().rawWarning}</NoticeCard>
                    </Show>
                  </Show>
                  <Show when={format() === "json"}>
                    <TextInput
                      label={t().rowsKey}
                      description={t().rowsKeyHint}
                      value={rowsKey}
                      onValueChange={(value) => {
                        setRowsKey(value);
                        props.onDirty();
                      }}
                    />
                  </Show>
                  <Show when={format() === "pdf"}>
                    <TextInput
                      label={t().header}
                      value={header}
                      multiline
                      lines={3}
                      maxLength={50_000}
                      onValueChange={(value) => {
                        setHeader(value);
                        props.onDirty();
                      }}
                    />
                    <TextInput
                      label={t().footer}
                      value={footer}
                      multiline
                      lines={3}
                      maxLength={50_000}
                      onValueChange={(value) => {
                        setFooter(value);
                        props.onDirty();
                      }}
                    />
                    <TextInput
                      label={t().css}
                      value={css}
                      multiline
                      lines={4}
                      maxLength={50_000}
                      onValueChange={(value) => {
                        setCss(value);
                        props.onDirty();
                      }}
                    />
                  </Show>
                </div>
              </DetailPanel.Section>
            </Show>
            <p class="text-sm text-dimmed">{t().reviewHint}</p>
            <Button
              variant="primary"
              class="self-end"
              disabled={!name().trim() || ((format() === "pdf" || format() === "xml") && !(format() === "pdf" ? pdf() : xml()).trim())}
              onClick={() =>
                props.onComplete({
                  name: name().trim(),
                  description: "",
                  enabled: false,
                  source: queryExportWorkflowSource(source(), output(), undefined, inputs()),
                  launcher: { name: name().trim(), config: { kind: "customApp", inputMode: "prompt" } },
                })
              }
            >
              {t().review}
            </Button>
          </>
        }
      >
        <GqlSourceEditor
          baseId={props.baseId}
          value={source}
          onValueChange={editQuery}
          variant="paper"
          label={t().query}
          aria-label={t().query}
          contextKeys={inputs()
            .filter((input) => /^[a-z][a-z0-9_]*$/.test(input.name))
            .map((input) => `params.${input.name}` as const)}
        />
        <DetailPanel.Section title={t().parameters} collapsible>
          <div class="flex flex-col gap-3">
            <p class="text-sm text-dimmed">{t().parametersHint}</p>
            <Index each={inputs()}>
              {(input) => (
                <div class="grid items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                  <TextInput
                    label={t().parameterName}
                    value={() => input().name}
                    onValueChange={(name) => changeInputs(inputs().map((item) => (item.id === input().id ? { ...item, name } : item)))}
                  />
                  <Select
                    label={t().parameterType}
                    value={() => input().type}
                    options={parameterTypes.map((type) => ({ id: type, label: type }))}
                    onValueChange={(type) => {
                      const selected = parameterTypes.find((value) => value === type);
                      if (selected) changeInputs(inputs().map((item) => (item.id === input().id ? { ...item, type: selected } : item)));
                    }}
                  />
                  <Show
                    when={input().type === "boolean"}
                    fallback={
                      <TextInput
                        label={t().sample}
                        description={
                          input().type === "decimal"
                            ? t().decimalHint
                            : input().type === "date"
                              ? t().dateHint
                              : input().type === "dateTime"
                                ? t().dateTimeHint
                                : undefined
                        }
                        value={() => input().sample}
                        onValueChange={(sample) =>
                          changeInputs(inputs().map((item) => (item.id === input().id ? { ...item, sample } : item)))
                        }
                      />
                    }
                  >
                    <Select
                      label={t().sample}
                      value={() => input().sample}
                      options={[
                        { id: "true", label: t().yes },
                        { id: "false", label: t().no },
                      ]}
                      onValueChange={(value) =>
                        changeInputs(inputs().map((item) => (item.id === input().id ? { ...item, sample: value ?? "" } : item)))
                      }
                    />
                  </Show>
                  <Button
                    variant="ghost"
                    aria-label={t().removeParameter}
                    onClick={() => changeInputs(inputs().filter((item) => item.id !== input().id))}
                  >
                    <i class="ti ti-trash" />
                  </Button>
                </div>
              )}
            </Index>
            <Button
              variant="input"
              class="self-start"
              disabled={inputs().length >= 100}
              onClick={() => changeInputs([...inputs(), { id: nextInputId++, name: "", type: "text", sample: "" }])}
            >
              <i class="ti ti-plus" />
              {t().addParameter}
            </Button>
          </div>
        </DetailPanel.Section>
        <div class="flex flex-wrap gap-2">
          <Button variant="input" disabled={loading() || !source().trim()} onClick={() => void loadPreview()}>
            <i class={loading() ? "ti ti-loader-2 animate-spin" : "ti ti-player-play"} />
            {t().preview}
          </Button>
          <Button variant="primary" disabled={loading() || !result()} onClick={() => setStep("output")}>
            {t().next}
            <i class="ti ti-arrow-right" />
          </Button>
        </div>
        <p class="text-sm text-dimmed">{t().previewHint}</p>
        <Show when={failure()}>
          <NoticeCard tone="danger">{failure()}</NoticeCard>
        </Show>
        <Show when={diagnostics().length}>
          <NoticeCard tone="danger">
            <ul>
              <For each={diagnostics()}>{(item) => <li>{item.message}</li>}</For>
            </ul>
          </NoticeCard>
        </Show>
        <Show when={result()}>
          {(data) => (
            <div class="h-80 min-h-0">
              <QueryResultTable
                result={data()}
                baseId={props.baseId}
                fieldsByTable={props.fieldsByTable}
                scrollPreserveKey="workflow-query-export-preview"
                loading={loading()}
                canGoBack={Boolean(previewCursor())}
                backLabel="First page"
                onPrevious={() => void loadPreview()}
                onNext={(cursor) => void loadPreview(cursor)}
              />
            </div>
          )}
        </Show>
      </Show>
    </div>
  );
}

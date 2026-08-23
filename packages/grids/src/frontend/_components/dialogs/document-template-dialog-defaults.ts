import type { DocumentTemplateStarter } from "../../../document-template-starters";

const defaultDocumentSource = (tableId: string) => `from table {${tableId}}\nwhere record.id = '{{ record.id }}'\nlimit 1`;
export const defaultDocumentNumberTemplate = "{{ template.id }}-{{ date.yyyyMMdd }}-{{ document.id }}";
const defaultDocumentFilenameTemplate = "{{ document.number }}.pdf";

export const defaultDocumentStarter = (): DocumentTemplateStarter => ({
  id: "blank",
  name: "Blank template",
  description: "Simple record detail template.",
  icon: "ti ti-file-type-pdf",
  category: "Blank",
  bestFor: "Starting from a minimal record detail layout.",
  expectedData: "One selected record.",
  page: "A4 portrait",
  source: (tableId) => defaultDocumentSource(tableId),
  renderer: {
    kind: "html",
    body: defaultDocumentHtml,
    numberTemplate: defaultDocumentNumberTemplate,
    filenameTemplate: defaultDocumentFilenameTemplate,
  },
});

const defaultDocumentHtml = `<html>
  <head>
    <style>
      body { font-family: system-ui, sans-serif; margin: 40px; color: #18181b; }
      h1 { margin: 0 0 12px; font-size: 24px; }
      table { width: 100%; border-collapse: collapse; margin-top: 24px; }
      th, td { border-bottom: 1px solid #e4e4e7; padding: 8px; text-align: left; }
    </style>
  </head>
  <body>
    <h1>{{ table.name }} · {{ record.id }}</h1>
    <table>
      <tbody>
        {% for row in rows %}
          {% for column in columns %}
            <tr>
              <th>{{ column.label }}</th>
              <td>{{ row[column.key] }}</td>
            </tr>
          {% endfor %}
        {% endfor %}
      </tbody>
    </table>
  </body>
</html>`;

export const starterPayload = (starter: DocumentTemplateStarter, tableId: string) => ({
  name: starter.id === "blank" ? "" : starter.name,
  description: starter.id === "blank" ? "" : starter.description,
  source: starter.source(tableId),
  renderer: starter.renderer,
});

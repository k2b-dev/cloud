/**
 * Local click-through fixtures, through the same CLI/API as a Cloud user.
 * Preview: bun packages/grids/scripts/seed-template-demos.ts
 * Create/resume: bun packages/grids/scripts/seed-template-demos.ts --create --state /tmp/grids-template-demos.json
 * Select one: ... --templates inventory,billing
 * Never sends emails, replaces existing Bases, or changes the selected CLI Base.
 */
import { createMockCover } from "@k2b/cloud/shared";
import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getTemplates } from "../src/templates";
import type { GridTemplate } from "../src/templates/types";

const args = Bun.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
};
const statePath = resolve(option("--state") ?? "/tmp/grids-template-demos.json");
const selected = (option("--templates") ?? "bookshop,finance,inventory,billing").split(",");
const templates = getTemplates("de").filter((template) => selected.includes(template.id));
if (templates.length !== new Set(selected).size) throw new Error("Unknown or repeated template ID");
const root = resolve(import.meta.dir, "../../..");
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected API object");
  return Object.fromEntries(Object.entries(value));
};
const list = (value: unknown): Record<string, unknown>[] => {
  const rows = Array.isArray(value) ? value : object(value).items;
  if (!Array.isArray(rows)) throw new Error("Expected API list");
  return rows.map(object);
};
const string = (value: unknown): string => {
  if (typeof value !== "string" || !value) throw new Error("Expected API string");
  return value;
};
const id = (value: unknown) => string(object(value).id);
const state: Record<string, unknown> = (await Bun.file(statePath).exists()) ? object(await Bun.file(statePath).json()) : {};
state.date ??= new Date().toISOString().slice(0, 10);
const date = (days: number) => {
  const value = new Date(`${string(state.date)}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
async function save() {
  await mkdir(dirname(statePath), { recursive: true });
  await Bun.write(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  await rename(`${statePath}.tmp`, statePath);
}
async function cli(args: string[], body?: unknown): Promise<unknown> {
  const process = Bun.spawn(
    ["bun", "run", "dev:cld", "--", "--locale", "de", "grids", ...args, "--json", ...(body === undefined ? [] : ["--stdin"])],
    { cwd: root, stdin: body === undefined ? "ignore" : new Blob([JSON.stringify(body)]), stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode) throw new Error(`${args.join(" ")}: ${stderr}\n${stdout}`);
  return JSON.parse(stdout);
}

class Demo {
  readonly stored: Record<string, unknown>;
  readonly tables = new Map<string, string>();
  readonly fields = new Map<string, string>();
  readonly workflowRevisions = new Map<string, number>();
  constructor(readonly template: GridTemplate) {
    this.stored = state[template.id] ? object(state[template.id]) : {};
    state[template.id] = this.stored;
  }
  get base() {
    return string(this.stored.base);
  }
  async once(key: string, action: () => Promise<unknown>) {
    if (this.stored[key] !== undefined) return this.stored[key];
    // Mutations with uncertain outcomes are never silently retried. Workflow/form
    // operations additionally use stable server-side idempotency keys.
    if (this.stored.pending) throw new Error(`Uncertain prior operation: ${this.stored.pending}. Inspect the Base before resuming.`);
    this.stored.pending = key;
    await save();
    const result = await action();
    this.stored[key] = result;
    delete this.stored.pending;
    await save();
    if (Object.keys(this.stored).length % 25 === 0)
      console.log(`${this.template.name}: ${Object.keys(this.stored).length} Schritte abgeschlossen`);
    return result;
  }
  async init() {
    await this.once("base", async () =>
      id(
        await cli(["templates", "instantiate", this.template.id, "--empty", "--name", `${this.template.name} · Volle Demo ${state.date}`]),
      ),
    );
    const base = object(await cli(["bases", "get", "--base", this.base]));
    this.stored.owner = string(base.createdBy);
    for (const workflow of list(await cli(["workflows", "list", "--base", this.base]))) {
      if (typeof workflow.revision !== "number" || !Number.isInteger(workflow.revision) || workflow.revision < 1)
        throw new Error("Invalid workflow revision");
      this.workflowRevisions.set(string(workflow.name), workflow.revision);
    }
    const tables = list(await cli(["tables", "list", "--base", this.base]));
    for (const table of this.template.tables) {
      const installed = tables.find((item) => item.name === table.name);
      if (!installed) throw new Error(`Missing installed table ${table.name}`);
      this.tables.set(table.key, id(installed));
      const fields = list(await cli(["fields", "list", "--base", this.base, "--table", id(installed)]));
      for (const field of table.fields) {
        const installedField = fields.find((item) => item.name === field.name);
        if (!installedField) throw new Error(`Missing installed field ${table.key}.${field.key}`);
        this.fields.set(`${table.key}.${field.key}`, id(installedField));
      }
    }
  }
  table(key: string) {
    return string(this.tables.get(key));
  }
  field(table: string, key: string) {
    return string(this.fields.get(`${table}.${key}`));
  }
  optionLabel(table: string, field: string, option: string) {
    const definition = this.template.tables.find((entry) => entry.key === table)?.fields.find((entry) => entry.key === field);
    const options = definition?.config?.options;
    if (!Array.isArray(options)) throw new Error(`Missing select options ${table}.${field}`);
    return string(options.map(object).find((entry) => entry.id === option)?.label);
  }
  values(table: string, values: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [this.field(table, key), value]));
  }
  async create(table: string, key: string, values: Record<string, unknown>) {
    return string(
      await this.once(key, async () =>
        id(await cli(["records", "create", "--base", this.base, "--table", this.table(table)], this.values(table, values))),
      ),
    );
  }
  async import(table: string, values: Record<string, unknown>[]) {
    const result = await this.once(`import-${table}`, async () =>
      list(
        await cli(["records", "import", "--base", this.base, "--table", this.table(table)], {
          items: values.map((row) => this.values(table, row)),
        }),
      ).map(id),
    );
    if (!Array.isArray(result) || result.length !== values.length) throw new Error(`Incomplete import ${table}`);
    return result.map(string);
  }
  async form(key: string, formKey: string, values: Record<string, unknown>, recordId?: string) {
    const form = this.template.forms?.find((form) => form.key === formKey);
    if (!form) throw new Error(`Missing template form ${formKey}`);
    return string(
      await this.once(key, async () => {
        const existing = recordId
          ? object(await cli(["records", "get", "--base", this.base, "--table", this.table(form.table), recordId]))
          : undefined;
        const result = object(
          await cli(
            [
              "forms",
              "submit",
              "--base",
              this.base,
              "--table",
              this.table(form.table),
              "--form",
              form.name,
              ...(recordId ? ["--record", recordId, "--yes"] : []),
            ],
            {
              data: this.values(form.table, values),
              idempotencyKey: `demo-${this.base}-${key}`,
              ...(existing ? { version: existing.version } : {}),
            },
          ),
        );
        return string(result.recordId);
      }),
    );
  }
  async workflow(key: string, workflowKey: string, inputs: Record<string, unknown>) {
    const workflow = this.template.workflows?.find((workflow) => workflow.key === workflowKey);
    if (!workflow) throw new Error(`Missing workflow ${workflowKey}`);
    if (/sendEmail:/.test(workflow.source)) throw new Error(`Demo must never send email: ${workflowKey}`);
    const revision = this.workflowRevisions.get(workflow.name);
    if (revision === undefined) throw new Error(`Missing installed workflow ${workflowKey}`);
    const started = object(
      await this.once(`${key}:run`, () =>
        cli(
          [
            "workflows",
            "invoke",
            "--base",
            this.base,
            "--workflow",
            workflow.name,
            "--idempotency-key",
            `demo-${this.base}-${key}`,
            "--expected-revision",
            String(revision),
          ],
          inputs,
        ),
      ),
    );
    return object(
      await this.once(`${key}:done`, async () => {
        const deadline = Date.now() + 180_000;
        while (Date.now() < deadline) {
          const run = object(await cli(["workflow-runs", "get", string(started.runId)]));
          if (run.status === "succeeded") return run;
          if (["failed", "needs_attention", "canceled"].includes(String(run.status))) throw new Error(JSON.stringify(run));
          await Bun.sleep(350);
        }
        throw new Error(`Workflow ${started.runId} still running; inspect before resuming`);
      }),
    );
  }
  async cover(table: string, field: string, key: string, record: string, label: string) {
    return this.once(`cover-${key}`, async () => {
      const path = `/tmp/grids-demo-${this.base}-${key}.svg`;
      const icon =
        table === "books"
          ? "book"
          : label.startsWith("Systemkamera")
            ? "camera"
            : label.startsWith("Funkmikrofon")
              ? "microphone"
              : label.startsWith("Projektor")
                ? "device-projector"
                : "package";
      const cover = createMockCover({ icon, seed: key, label });
      await Bun.write(path, cover.svg);
      return cli([
        "records",
        "files",
        "upload",
        "--base",
        this.base,
        "--table",
        this.table(table),
        "--record",
        record,
        "--field",
        this.field(table, field),
        "--file",
        path,
        "--mime-type",
        "image/svg+xml",
      ]);
    });
  }
  async document(key: string, templateKey: string, record: string) {
    const template = this.template.documentTemplates?.find((item) => item.key === templateKey);
    if (!template) throw new Error(`Missing Document template ${templateKey}`);
    return this.once(`document-${key}`, () =>
      cli([
        "documents",
        "generate",
        "--base",
        this.base,
        "--table",
        this.table(template.table),
        "--template",
        string(template.name),
        "--record",
        record,
        "--idempotency-key",
        `demo-${this.base}-${key}`,
        "--out",
        `/tmp/grids-demo-${this.base}-${key}.pdf`,
      ]),
    );
  }
  async finish() {
    const apps = list(await cli(["apps", "list", "--base", this.base]));
    const appPages = new Map<string, string>();
    for (const app of apps) {
      await this.once(`grant-app-${id(app)}`, () =>
        cli(["access", "grant", "app", this.base, id(app), "--user", string(this.stored.owner), "--permission", "read"]),
      );
      const runtime = object(await cli(["apps", "runtime", "read", id(app)]));
      if (
        !Array.isArray(runtime.blocks) ||
        runtime.blocks.map(object).some((block) => block.error || (block.records && object(block.records).ok !== true))
      )
        throw new Error(`App ${id(app)} has runtime errors`);
      appPages.set(id(app), string(object(runtime.page).id));
    }
    this.stored.apps = apps.map((app) => ({
      id: id(app),
      name: app.name,
      url: `http://localhost:3000/apps/${id(app)}/${string(appPages.get(id(app)))}`,
    }));
    this.stored.counts = Object.fromEntries(
      await Promise.all(
        [...this.tables].map(async ([key, table]) => {
          const result = object(await cli(["records", "list", "--base", this.base, "--table", table, "--limit", "200"]));
          const count = list(result).length;
          const expected = expectedCounts[this.template.id]?.[key];
          if (expected === undefined || count < expected)
            throw new Error(`Incomplete ${this.template.id}.${key}: expected ${expected}, got ${count}`);
          return [key, count];
        }),
      ),
    );
    this.stored.complete = true;
    await save();
    console.log(JSON.stringify({ template: this.template.id, base: this.base, apps: this.stored.apps, counts: this.stored.counts }));
  }
}

const expectedCounts: Record<string, Record<string, number>> = {
  bookshop: { authors: 6, genres: 6, books: 30, customers: 24, orders: 40, order_lines: 100 },
  finance: { accounts: 4, categories: 8, merchants: 16, budgets: 21, transactions: 108 },
  inventory: { categories: 5, locations: 5, items: 40, kits: 12, loans: 25, loan_positions: 44 },
  billing: { parties: 30, bills: 44, payments: 26 },
};

const names = [
  "Nordlicht",
  "Donau",
  "Abendrot",
  "Bergblick",
  "Werkraum",
  "Morgenstern",
  "Wald & Wiese",
  "Papierhafen",
  "Studio Sieben",
  "Fahrradkontor",
  "Lichtblick",
  "Korn & Kruste",
  "Brückenbau",
  "Seeblick",
  "Eichenblatt",
  "Rosenhof",
  "Klangraum",
  "Kleine Wolke",
  "Form & Farbe",
  "Hafenwerk",
  "Leselust",
  "Sonnenweg",
  "Marktplatz",
  "Flusswärts",
  "Neue Wege",
  "Pixelgarten",
  "Mühlenviertel",
  "Stadtfuchs",
  "Blattwerk",
  "Freiraum",
];

async function seedBookshop(d: Demo) {
  const authors = await d.import(
    "authors",
    ["Mara Winter", "Jonas Berg", "Hannah Fischer", "Emil Sommer", "Nora König", "Luca Stern"].map((name, i) => ({
      name,
      birth_year: String(1965 + i * 4),
      country: ["de"],
      bio: "Fiktive Person für diese Demo.",
    })),
  );
  const genres = await d.import(
    "genres",
    ["Roman", "Sachbuch", "Kinderbuch", "Krimi", "Reisen", "Kochen"].map((name) => ({
      name,
      description: `Lesestoff rund um ${name.toLowerCase()}.`,
    })),
  );
  const titles = Array.from(
    { length: 30 },
    (_, i) =>
      `${["Die stille Stadt", "Wege ins Grüne", "Am Rand der Welt", "Kleine große Fragen", "Das letzte Licht", "Einfach gut kochen"][i % 6]}${i < 6 ? "" : ` · Band ${1 + Math.floor(i / 6)}`}`,
  );
  const books = await d.import(
    "books",
    titles.map((title, i) => ({
      title,
      author: [authors[i % authors.length]],
      genre: [genres[i % genres.length]],
      description: "Fiktiver Katalogtitel. Zum Ausprobieren von Suche, Bestellung und Katalogpflege.",
      pages: String(120 + i * 7),
      price: (9.9 + (i % 8) * 2.5).toFixed(2),
      published: date(-400 + i * 8),
      in_stock: i % 7 !== 0,
      tags: i % 3 === 0 ? ["recommended"] : [],
      score: String(3 + (i % 3)),
    })),
  );
  for (let i = 0; i < books.length; i++) await d.cover("books", "cover", `book-${i}`, string(books[i]), string(titles[i]));
  const customers = await d.import(
    "customers",
    Array.from({ length: 24 }, (_, i) => ({
      name: `${["Anna", "Ben", "Clara", "David", "Emilia", "Felix"][i % 6]} ${names[i]}`,
      email: `kunde-${i + 1}@example.test`,
      joined: date(-180 + i * 4),
      source: ["store"],
      notes: i % 4 === 0 ? "Bevorzugt Abholung im Laden." : "",
    })),
  );
  const orders = await d.import(
    "orders",
    Array.from({ length: 40 }, (_, i) => ({
      customer: [customers[i % customers.length]],
      ordered_at: date(-i),
      status: [["new", "shipped", "delivered"][i % 3]],
      invoice_ready: i % 3 !== 0,
      invoice_sent: ["ready"],
    })),
  );
  await d.import(
    "order_lines",
    orders.flatMap((order, i) =>
      Array.from({ length: 1 + (i % 4) }, (_, j) => ({
        order: [order],
        book: [books[(i + j) % books.length]],
        quantity: String(1 + (j % 3)),
        unit_price: (9.9 + ((i + j) % 8) * 2.5).toFixed(2),
      })),
    ),
  );
  for (let i = 0; i < 4; i++) await d.document(`order-${i}`, "order_invoice", string(orders[i]));
}

async function seedFinance(d: Demo) {
  const accounts = await d.import(
    "accounts",
    ["Girokonto", "Tagesgeld", "Portemonnaie", "Kreditkarte"].map((name, i) => ({
      name,
      kind: [["checking", "savings", "cash", "credit"][i]],
      opening_balance: ["2400.00", "8000.00", "120.00", "0.00"][i],
    })),
  );
  const categories = await d.import(
    "categories",
    ["Gehalt", "Lebensmittel", "Wohnen", "Mobilität", "Freizeit", "Essen gehen", "Gesundheit", "Urlaub"].map((name, i) => ({
      name,
      kind: [i === 0 ? "income" : "expense"],
      fixed: i === 0 || i === 2,
    })),
  );
  const merchants = await d.import(
    "merchants",
    Array.from({ length: 16 }, (_, i) => ({
      name: i === 0 ? "Musterwerk Arbeitgeber" : `${names[i]} ${["Markt", "Service", "Café", "Buchladen"][i % 4]}`,
      default_category: [categories[i % 8]],
    })),
  );
  const budgets: Record<string, unknown>[] = [],
    transactions: Record<string, unknown>[] = [];
  for (let month = 0; month < 3; month++) {
    const start = new Date(`${string(state.date)}T12:00:00Z`);
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() - month);
    for (let category = 1; category < 8; category++)
      budgets.push({
        month: start.toISOString().slice(0, 10),
        category: [categories[category]],
        limit: ["0", "420", "1100", "120", "180", "100", "150", "400"][category],
      });
    for (let i = 0; i < 36; i++) {
      const txDate = new Date(start);
      txDate.setUTCDate(1 + (i % (month === 0 ? Number(string(state.date).slice(-2)) : 28)));
      const income = i === 0,
        category = income ? 0 : i === 1 ? 2 : i % 6 === 0 ? 1 : 2 + (i % 6);
      transactions.push({
        date: txDate.toISOString().slice(0, 10),
        merchant: [merchants[income ? 0 : 1 + (i % 15)]],
        account: [accounts[income ? 0 : i % 3 === 0 ? 2 : i % 3 === 1 ? 0 : 3]],
        category: [categories[category]],
        type: [income ? "income" : "expense"],
        amount: income ? "3250.00" : i === 1 ? "980.00" : (8.5 + (i % 12) * 13.7).toFixed(2),
        cleared: month > 0 || i % 5 !== 0,
        notes: i % 9 === 0 ? "Demo · Zur Abstimmung mit dem Kontoauszug." : "",
        receipt_email: "demo@example.test",
        receipt_sent: ["ready"],
      });
    }
  }
  await d.import("budgets", budgets);
  const ids = await d.import("transactions", transactions);
  for (let i = 1; i < 4; i++) await d.document(`transaction-${i}`, "transaction_receipt", string(ids[i]));
}

async function seedInventory(d: Demo) {
  const categories = await d.import(
    "categories",
    ["Kameras", "Audio", "Licht", "Präsentation", "Zubehör"].map((name) => ({ name })),
  );
  const locations = await d.import(
    "locations",
    Array.from({ length: 5 }, (_, i) => ({
      name: `Lager ${i + 1}`,
      room: ["Studio", "Medienraum", "Werkstatt", "Büro", "Archiv"][i],
      shelf: `Regal ${String.fromCharCode(65 + i)}`,
    })),
  );
  const itemNames = Array.from(
    { length: 40 },
    (_, i) => `${["Systemkamera", "Funkmikrofon", "LED-Leuchte", "Projektor", "Stativ"][i % 5]} ${1 + Math.floor(i / 5)}`,
  );
  const items = await d.import(
    "items",
    itemNames.map((name, i) => ({
      name,
      category: [categories[i % 5]],
      location: [locations[i % 5]],
      status: [i >= 36 ? "maintenance" : "available"],
      condition: [i >= 36 ? "repair" : i % 3 === 0 ? "new" : "good"],
      serial_no: `DEMO-${String(i + 1).padStart(4, "0")}`,
      tags: ["shared"],
      quantity: "1",
      replacement_value: String([1250, 420, 180, 800, 95][i % 5]),
      purchase_date: date(-450 + i * 5),
      notes: i >= 36 ? "Demo · Funktionsprüfung vor der nächsten Ausgabe erforderlich." : "",
    })),
  );
  for (let i = 0; i < items.length; i++) await d.cover("items", "files", `item-${i}`, string(items[i]), string(itemNames[i]));
  const kitContents = [
    { name: "Kamera, Ton & Licht", category: 0 },
    { name: "Ton, Licht & Projektion", category: 1 },
    { name: "Licht & Projektion", category: 3 },
    { name: "Präsentation & Kamera", category: 3 },
    { name: "Kamera & Ton", category: 0 },
  ];
  const kits = await d.import(
    "kits",
    Array.from({ length: 12 }, (_, i) => ({
      name: `${kitContents[(i * 3) % 5]!.name} · Set ${1 + Math.floor(i / 5)}`,
      category: [categories[kitContents[(i * 3) % 5]!.category]],
      items: items.slice(i * 3, i * 3 + 3),
      status: ["available"],
      requestable: i !== 11,
      description: `Enthält ${itemNames.slice(i * 3, i * 3 + 3).join(", ")}.`,
      notes: i === 11 ? "Nur für interne Schulungen." : "",
    })),
  );
  const loans = await d.import(
    "loans",
    Array.from({ length: 25 }, (_, i) => ({
      requester_name: `${["Anna", "Ben", "Clara", "David", "Emilia"][i % 5]} ${names[i]}`,
      requester_email: `ausleihe-${i + 1}@example.test`,
      organization: `${names[i]} Team`,
      kits: [kits[i % 12]],
      start_date: date(i < 12 ? -15 : 2 + i),
      due_date: date(i < 4 ? -i - 1 : i < 12 ? 4 + i : 6 + i),
      status: [i === 24 ? "rejected" : i > 21 ? "cancelled" : "requested"],
      ...(i === 24 ? { rejection_reason: "Für diesen Termin steht kein vollständiges Set zur Verfügung." } : {}),
      availability_confirmed: i < 14,
      agreement_sent: ["ready"],
      purpose: ["Interview aufnehmen", "Workshop dokumentieren", "Teamveranstaltung", "Produktfotos"][i % 4],
      notes: i < 12 ? "Demo · Ausgabe und Rückgabe zum Durchklicken; keine E-Mail versendet." : "",
    })),
  );
  const positions = await d.import(
    "loan_positions",
    loans
      .slice(0, 22)
      .flatMap((loan, i) => Array.from({ length: 2 }, (_, j) => ({ loan: [loan], item: [items[(i % 12) * 3 + j]], status: ["planned"] }))),
  );
  for (let i = 0; i < 14; i++) {
    const loan = string(loans[i]);
    await d.workflow(`approve-${i}`, "approve_loan", { loan });
    if (i >= 12) continue;
    for (let j = 0; j < 2; j++) {
      await d.workflow(`issue-${i}-${j}`, "issue_position", { position: positions[i * 2 + j] });
      if (i >= 8 || (i === 7 && j === 0))
        await d.workflow(`return-${i}-${j}`, "return_loan_item", {
          item: items[i * 3 + j],
          condition: d.optionLabel("items", "condition", "good"),
        });
    }
    if (i < 3) await d.document(`agreement-${i}`, "loan_agreement", loan);
    if (i >= 8) await d.workflow(`close-${i}`, "close_loan", { loan });
  }
}

async function seedBilling(d: Demo) {
  await d.once("company", () =>
    cli(["bases", "update", "--base", d.base], {
      description: "Fiktive UX-Demo. Keine echten Geschäftsvorfälle oder Geldtransfers.",
      documentDefaults: {
        legalName: "Musterwerk Studio GmbH · DEMO",
        vatId: "DE123456789",
        address: "Musterstraße 12",
        postalCode: "89073",
        city: "Ulm",
        countryCode: "DE",
        iban: "DE89370400440532013000",
        accountName: "Musterwerk Studio GmbH · DEMO",
      },
    }),
  );
  const parties: string[] = [],
    bills: string[] = [];
  for (let i = 0; i < 30; i++)
    parties.push(
      await d.create("parties", `party-${i}`, {
        name: `${names[i]} · DEMO`,
        vat_id: `DE${987650000 + i}`,
        street: `Beispielweg ${i + 1}`,
        postal_code: "89073",
        city: "Ulm",
        iban: "DE89370400440532013000",
        account_name: `${names[i]} · DEMO`,
      }),
    );
  for (let i = 0; i < 40; i++) {
    const commission = i >= 32,
      draft = (i >= 25 && i < 32) || i >= 38;
    const positions = Array.from({ length: i === 30 ? 12 : 1 + (i % 5) }, (_, j) => ({
      Label1: ["Konzeptworkshop", "Webdesign", "Fotopaket", "Redaktion", "Projektbegleitung"][j % 5],
      Detail: "Fiktive Leistung für die Demo",
      Qty001: String(1 + (j % 3)),
      Unit01: ["C62"],
      Price1: String([450, 680, 240, 160, 125][j % 5]),
      Vat001: [j === 2 ? "vat007" : "vat019"],
    }));
    const bill = await d.form(`bill-${i}`, commission ? "new_self_billing" : "new_invoice", {
      party: [parties[i % 30]],
      invoice_date: date(-35),
      service_date: date(-40),
      due_date: date(i < 12 ? -1 - i : i < 16 ? 0 : 1 + (i % 20)),
      buyer_reference: `DEMO-${String(i + 1).padStart(3, "0")}`,
      positions,
      ...(commission ? { agreement: `DEMO · Provisionsvereinbarung ${i + 1}` } : {}),
    });
    bills.push(bill);
    if (draft) continue;
    await d.workflow(`issue-${i}`, commission ? "issue_self_billing" : "issue_invoice", { bill });
    if (i % 4 !== 0 && !d.stored[`payment-${i}:done`]) {
      const record = object(await cli(["records", "get", "--base", d.base, "--table", d.table("bills"), bill]));
      const gross = Number(object(record.data)[d.field("bills", "gross")]);
      if (!Number.isFinite(gross) || gross <= 0) throw new Error(`Missing positive bill total: ${bill}`);
      await d.workflow(`payment-${i}`, commission ? "record_payout" : "record_payment", {
        bill,
        date: date(-1),
        amount: (i % 4 === 1 ? gross : i % 4 === 2 ? gross / 2 : gross + 50).toFixed(2),
        reference: "DEMO · Simulierter Kontoauszug, kein echter Geldfluss",
      });
    }
  }
  for (let i = 0; i < 4; i++) {
    const result = await d.workflow(`correction-${i}`, "new_correction", { bill: bills[i] });
    const correction = string(object(result.result).recordId);
    const record = object(await cli(["records", "get", "--base", d.base, "--table", d.table("bills"), correction]));
    const rawPositions = object(record.data)[d.field("bills", "positions")];
    if (!Array.isArray(rawPositions)) throw new Error("Missing correction positions");
    const positions = rawPositions.map((position) =>
      Object.fromEntries(
        Object.entries(object(position)).filter(([key]) => ["Label1", "Detail", "Qty001", "Unit01", "Price1", "Vat001"].includes(key)),
      ),
    );
    await d.form(
      `correction-edit-${i}`,
      "edit_correction",
      {
        positions,
        reason: "DEMO · Auftrag einvernehmlich reduziert",
        invoice_date: date(0),
        service_date: date(-40),
        due_date: date(14),
        buyer_reference: `DEMO-KOR-${i + 1}`,
        notes: "Fiktive Korrektur für die Demo.",
      },
      correction,
    );
    if (i < 3) await d.workflow(`correction-issue-${i}`, "issue_correction", { bill: correction });
    if (i === 1)
      await d.workflow("refund-1", "record_refund", {
        bill: bills[i],
        date: date(0),
        amount: "50.00",
        reference: "DEMO · Tatsächlich erfolgte Erstattung simuliert",
      });
  }
  // Imported payments deliberately remain unconfirmed for the review queue.
  // A private temporary Form respects the table's form/workflow write policy.
  const importForm = string(
    await d.once("payment-import-form", async () =>
      id(
        await cli(["forms", "create", "--base", d.base, "--table", d.table("payments")], {
          name: "Demo-Zahlungsimport",
          config: {
            fields: ["bill", "date", "amount", "reference", "refund"].map((key) => ({
              kind: "user_input",
              fieldId: d.field("payments", key),
            })),
          },
        }),
      ),
    ),
  );
  for (const i of [4, 8, 32])
    await d.once(`pending-payment-${i}`, () =>
      cli(["forms", "submit", "--base", d.base, "--table", d.table("payments"), "--form", importForm], {
        data: d.values("payments", {
          bill: [bills[i]],
          date: date(-1),
          amount: "75.00",
          reference: "DEMO · Importierter Bankumsatz zum Abgleichen",
          refund: false,
        }),
        idempotencyKey: `demo-${d.base}-pending-${i}`,
      }),
    );
  await d.once("payment-import-form-removed", () =>
    cli(["forms", "delete", "--base", d.base, "--table", d.table("payments"), "--form", importForm, "--yes"]),
  );
}

if (!args.includes("--create")) {
  console.log("Preview only. Pass --create to create new local Bases and persist progress.");
  console.log(
    JSON.stringify(
      {
        server: "http://localhost:3000",
        statePath,
        templates: templates.map(({ id, name }) => ({ id, name })),
        plan: {
          bookshop: "30 books, 24 customers, 40 orders + lines",
          finance: "4 accounts, 21 budgets, 108 transactions",
          inventory: "40 items, 12 kits, 25 loans + handovers/returns",
          billing: "30 partners, 40 bills + PDF, payments, 4 corrections",
        },
      },
      null,
      2,
    ),
  );
} else {
  for (const template of templates) {
    const demo = new Demo(template);
    console.log(`Preparing ${template.name}…`);
    await demo.init();
    if (template.id === "bookshop") await seedBookshop(demo);
    else if (template.id === "finance") await seedFinance(demo);
    else if (template.id === "inventory") await seedInventory(demo);
    else if (template.id === "billing") await seedBilling(demo);
    await demo.finish();
  }
  console.log(`Demo inventory saved to ${statePath}`);
}

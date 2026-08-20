import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudCliContext, CloudCliFlags } from "@valentinkolb/cloud/cli";
import gridsCli from "./cli";
import { accessCommands } from "./cli/access";
import { baseCrudCommands } from "./cli/bases";
import { customAppCommands } from "./cli/custom-apps";
import { documentCommands, documentTemplateCommands } from "./cli/documents";
import { evidenceCommands } from "./cli/evidence";
import { formCommands } from "./cli/forms";
import { recordCommands, snapshotCommands } from "./cli/records";
import { fieldCommands, tableCommands } from "./cli/schema";
import { baseTemplateCommands } from "./cli/templates";
import { formulaCommands, gqlCommands, viewCommands } from "./cli/views-gql";
import { emailTemplateCommands, workflowCommands, workflowEmailCommands, workflowRunCommands } from "./cli/workflows";
import { WORKFLOW_REVISION_HEADER } from "./workflows/contracts";

const commandGroups = [
  baseCrudCommands,
  baseTemplateCommands,
  accessCommands,
  customAppCommands,
  gqlCommands,
  formulaCommands,
  tableCommands,
  fieldCommands,
  recordCommands,
  viewCommands,
  formCommands,
  documentTemplateCommands,
  documentCommands,
  evidenceCommands,
  snapshotCommands,
  emailTemplateCommands,
  workflowCommands,
  workflowRunCommands,
  workflowEmailCommands,
] as const;

type FetchCall = {
  path: string;
  init?: RequestInit;
};

const baseId = "bk001A";
const tableId = "auth1A";
const fieldId = "name1A";
const recordId = "rec001";
const viewId = "view1A";
const documentTemplateId = "doc01A";
const emailTemplateId = "mail1A";
const workflowId = "wf001A";
const runId = "wrun01";
const formId = "frm01A";
const snapshotId = "snap01";
const documentRunId = "run01A";
const documentLinkId = "link01";
const fileId = "file01";
const accessId = "23232323-2323-4232-8232-232323232323";
const auditQuestionId = "34343434-3434-4434-8434-343434343434";
const combinedTableId = "all01A";
const sourceTableId = "src01A";
const customAppId = "app01A";

const jsonResponse = (value: unknown, status = 200) => Response.json(value, { status });

const createContext = (
  args: string[],
  flags: CloudCliFlags = {},
  responses: Response[] = [],
  options: { output?: "text" | "json" | "jsonl"; defaultBase?: string } = {},
) => {
  const calls: FetchCall[] = [];
  const lines: string[] = [];
  const jsonValues: unknown[] = [];
  const tables: unknown[][] = [];
  const defaults: Record<string, string | undefined> = { "grids.base": options.defaultBase };
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "test", server: "http://cloud.test", token: "token", output: options.output ?? "text" },
    getDefault: async (key) => defaults[key],
    setDefault: async (key, value) => {
      defaults[key] = value;
    },
    createApiClient: (() => {
      throw new Error("not needed");
    }) as CloudCliContext["createApiClient"],
    fetch: async (path, init) => {
      calls.push({ path, init });
      const response = responses.shift();
      if (!response) throw new Error(`Unexpected fetch: ${path}`);
      return response;
    },
    readJson: async (response) => {
      const text = await response.text();
      const value = text ? JSON.parse(text) : null;
      if (!response.ok) throw new Error(typeof value?.message === "string" ? value.message : response.statusText);
      return value;
    },
    print: (value = "") => lines.push(value),
    write: async (value) => void lines.push(value),
    error: (value) => lines.push(value),
    json: (value) => jsonValues.push(value),
    jsonLine: (value) => jsonValues.push(value),
    table: (rows) => tables.push(rows),
  };
  return { ctx, calls, defaults, lines, jsonValues, tables };
};

const base = {
  id: baseId,
  name: "Bookshop",
  description: "Books and authors",
  documentProfile: {},
  createdBy: null,
  deletedAt: null,
  createdAt: "2026-07-07T00:00:00.000Z",
  updatedAt: "2026-07-07T00:00:00.000Z",
};

const basePage = { items: [base], total: 1, limit: 500, offset: 0 };

const table = {
  id: tableId,
  baseId,
  name: "Authors",
  kind: "stored" as const,
  description: null,
  icon: "ti ti-table",
  columns: [],
  displayConfig: { mode: "table" },
  mutationPolicy: { mode: "all" as const },
  position: 0,
  disableDirectInsert: false,
  deletedAt: null,
  createdAt: "2026-07-07T00:00:00.000Z",
  updatedAt: "2026-07-07T00:00:00.000Z",
};

const combinedTable = {
  ...table,
  id: combinedTableId,
  name: "All authors",
  kind: "federated" as const,
  disableDirectInsert: true,
};

const field = {
  id: fieldId,
  tableId,
  name: "Name",
  description: null,
  icon: "ti ti-text",
  type: "text",
  config: {},
  position: 0,
  required: false,
  presentable: true,
  hideInTable: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: "2026-07-07T00:00:00.000Z",
  updatedAt: "2026-07-07T00:00:00.000Z",
};

const combinedDraftView = {
  tableId: combinedTableId,
  revision: 2,
  status: "draft" as const,
  diagnostics: [],
  createdBy: null,
  publishedBy: null,
  createdAt: "2026-07-18T08:00:00.000Z",
  updatedAt: "2026-07-18T08:05:00.000Z",
  revisionToken: "1752825900.000000",
  publishedAt: null,
  sources: [
    {
      sourceTableId: null,
      position: 0,
      authorizedAt: "2026-07-17T12:00:00.000Z",
      revokedAt: null,
    },
  ],
  mappings: [],
};

const record = {
  id: recordId,
  tableId,
  data: { [fieldId]: "Ursula K. Le Guin" },
  version: 1,
  deletedAt: null,
  createdBy: null,
  updatedBy: null,
  createdAt: "2026-07-07T00:00:00.000Z",
  updatedAt: "2026-07-07T00:00:00.000Z",
};

const view = {
  id: viewId,
  tableId,
  name: "Recent authors",
  description: null,
  icon: "ti ti-table-star",
  source: "from table Authors",
  ui: {},
  ownerUserId: null,
  position: 0,
  deletedAt: null,
  createdAt: "2026-07-07T00:00:00.000Z",
  updatedAt: "2026-07-07T00:00:00.000Z",
};

const form = {
  id: formId,
  tableId,
  name: "Author intake",
  config: { fields: [{ kind: "user_input", fieldId }] },
  publicToken: null,
  isActive: true,
  ownerUserId: null,
  position: 0,
  isDefault: false,
  deletedAt: null,
  createdAt: "2026-07-07T00:00:00.000Z",
  updatedAt: "2026-07-07T00:00:00.000Z",
};

const documentTemplate = {
  id: documentTemplateId,
  tableId,
  name: "Invoice",
  description: null,
  source: "from table Authors\nselect Name\nlimit 1",
  html: "<p>{{ record.id }}</p>",
  headerHtml: null,
  footerHtml: null,
  pageCss: null,
  numberTemplate: "{{ template.id }}-{{ run.id }}",
  filenameTemplate: "{{ document.number }}.pdf",
  enabled: true,
  position: 0,
  createdBy: null,
  updatedBy: null,
  deletedAt: null,
  createdAt: "2026-07-07T00:00:00.000Z",
  updatedAt: "2026-07-07T00:00:00.000Z",
};

const emailTemplate = {
  id: emailTemplateId,
  baseId,
  name: "Reminder",
  description: null,
  subject: "Reminder",
  html: "<p>Hello</p>",
  enabled: true,
  position: 0,
  createdBy: null,
  updatedBy: null,
  deletedAt: null,
  createdAt: "2026-07-07T00:00:00.000Z",
  updatedAt: "2026-07-07T00:00:00.000Z",
};

const workflow = {
  id: workflowId,
  baseId,
  name: "Send reminder",
  description: null,
  source: "steps:\n  - setVariable:\n      name: ok\n      value: true",
  plan: {
    schemaVersion: 2,
    languageId: "grids",
    languageVersion: 1,
    sourceHash: "source",
    manifestHash: "manifest",
    catalogHash: "catalog",
    inputs: [],
    triggers: [],
    steps: [],
    bindings: {},
  },
  diagnostics: [],
  enabled: true,
  position: 0,
  revision: 1,
  recordEventActiveSince: null,
  ownerUserId: null,
  deletedAt: null,
  createdAt: "2026-07-07T00:00:00.000Z",
  updatedAt: "2026-07-07T00:00:00.000Z",
};

const documentRun = {
  id: documentRunId,
  templateId: documentTemplateId,
  workflowRunId: null,
  snapshotId,
  baseId,
  tableId,
  recordId,
  documentNumber: "INV-20260707-0001",
  filename: "invoice.pdf",
  tags: ["invoice"],
  generatedBy: null,
  generatedAt: "2026-07-07T00:00:00.000Z",
};

const documentLink = {
  id: documentLinkId,
  documentRunId,
  baseId,
  tableId,
  recordId,
  comment: "Customer download",
  createdBy: null,
  createdAt: "2026-07-07T00:00:00.000Z",
  expiresAt: "2026-08-06T00:00:00.000Z",
  revokedAt: null,
  revokedBy: null,
  lastAccessedAt: null,
  accessCount: 0,
};

const recordSnapshot = {
  id: snapshotId,
  baseId,
  tableId,
  recordId,
  root: { record },
  graph: { records: [record] },
  createdBy: null,
  createdAt: "2026-07-07T00:00:00.000Z",
};

const gridFile = {
  id: fileId,
  recordId,
  fieldId,
  position: 0,
  filename: "cover.txt",
  mimeType: "text/plain",
  sizeBytes: 5,
  sha256: "abc123",
  createdBy: null,
  createdAt: "2026-07-07T00:00:00.000Z",
};

const accessEntry = {
  id: accessId,
  principal: { type: "user" as const, userId: "abababab-abab-4aba-8bab-abababababab" },
  permission: "read" as const,
  displayName: "Ada Lovelace",
  createdAt: "2026-07-07T00:00:00.000Z",
};

const customApp = {
  id: customAppId,
  baseId,
  name: "Public catalog",
  definition: {},
  publishedDefinition: {},
  publishedCapabilities: {},
  publishedAt: "2026-07-07T00:00:00.000Z",
  createdAt: "2026-07-07T00:00:00.000Z",
  updatedAt: "2026-07-07T00:00:00.000Z",
};

describe("grids CLI", () => {
  test("verifies evidence packages locally and returns structured failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grids-cli-evidence-"));
    const packagePath = join(dir, "invalid.tar");
    try {
      await writeFile(packagePath, new Uint8Array(1024));
      const { ctx, calls, jsonValues } = createContext(["evidence", "verify", packagePath], {}, [], { output: "json" });

      const exitCode = await gridsCli.run(ctx);

      expect(exitCode).toBe(1);
      expect(calls).toEqual([]);
      expect(jsonValues).toEqual([
        expect.objectContaining({
          valid: false,
          package: expect.objectContaining({ path: packagePath }),
          issues: expect.arrayContaining([expect.objectContaining({ code: "manifest.missing" })]),
        }),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("registers every command exported by its domain modules", async () => {
    const commands = commandGroups.flat();
    const paths = commands.map((item) => item.path.join(" "));

    expect(commands).toHaveLength(170);
    expect(new Set(paths).size).toBe(paths.length);

    for (const path of paths) {
      const { ctx, lines } = createContext([...path.split(" "), "help"]);
      expect(await gridsCli.run(ctx)).toBe(0);
      expect(lines[0]).toStartWith(`cld grids ${path}`);
    }
  });

  test("sets and reads the default base by public id", async () => {
    const { ctx, calls, defaults, lines } = createContext(["use", "bk001A"], {}, [
      jsonResponse({ items: [base], total: 1, limit: 500, offset: 0 }),
    ]);

    await gridsCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual(["/api/grids/bases?q=bk001A&limit=500&offset=0"]);
    expect(defaults["grids.base"]).toBe("bk001A");
    expect(lines).toEqual(["Using Grids base Bookshop (bk001A)."]);
  });

  test("shows and previews a Base retention floor through public ids", async () => {
    const policy = { baseId, minimumDays: 30, updatedAt: "2026-08-19T12:00:00.000Z" };
    const show = createContext(["bases", "retention", baseId], {}, [jsonResponse(basePage), jsonResponse({ policy })], { output: "json" });

    await gridsCli.run(show.ctx);

    expect(show.calls.at(-1)?.path).toBe(`/api/grids/bases/${baseId}/retention-policy`);
    expect(show.jsonValues).toEqual([{ policy }]);

    const preview = {
      observedAt: "2026-08-19T12:05:00.000Z",
      minimumDays: 30,
      counts: { trashedRecords: 2, floorReached: 1, retainedUntilLater: 1, protectedFinalized: 0 },
      examples: [
        {
          recordId,
          tableId,
          deletedAt: "2026-08-18T12:05:00.000Z",
          notBefore: "2026-09-17T12:05:00.000Z",
        },
      ],
      truncated: false,
      files: {
        counts: { unreferenced: 1, floorReached: 0, retainedUntilLater: 1, sizeBytes: 18 },
        examples: [
          {
            fileId,
            filename: "evidence.txt",
            sizeBytes: 18,
            unreferencedAt: "2026-08-18T12:05:00.000Z",
            notBefore: "2026-09-17T12:05:00.000Z",
          },
        ],
        truncated: false,
      },
    };
    const impact = createContext(
      ["bases", "retention", "preview", baseId],
      { days: "30" },
      [jsonResponse(basePage), jsonResponse(preview)],
      { output: "json" },
    );

    await gridsCli.run(impact.ctx);

    expect(impact.calls.at(-1)?.path).toBe(`/api/grids/bases/${baseId}/retention-policy/preview`);
    expect(impact.calls.at(-1)?.init?.method).toBe("POST");
    expect(JSON.parse(String(impact.calls.at(-1)?.init?.body))).toEqual({ minimumDays: 30 });
    expect(impact.jsonValues).toEqual([preview]);
  });

  test("lists and downloads unreferenced retained Files through public ids", async () => {
    const payload = {
      observedAt: "2026-08-19T12:05:00.000Z",
      minimumDays: 30,
      items: [
        {
          fileId,
          filename: "evidence.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          status: "retained",
          unreferencedAt: "2026-08-18T12:05:00.000Z",
          notBefore: "2026-09-17T12:05:00.000Z",
        },
      ],
      pagination: { page: 2, per_page: 10, total: 11, total_pages: 2, has_next: false },
    };
    const list = createContext(
      ["bases", "retention", "files", "list", baseId],
      { days: "30", search: "evidence", status: "retained", page: "2", "per-page": "10" },
      [jsonResponse(basePage), jsonResponse(payload)],
      { output: "json" },
    );
    await gridsCli.run(list.ctx);
    expect(list.calls.at(-1)?.path).toBe(
      `/api/grids/bases/${baseId}/retention-policy/files?minimumDays=30&search=evidence&status=retained&page=2&per_page=10`,
    );
    expect(list.jsonValues).toEqual([payload]);

    const dir = await mkdtemp(join(tmpdir(), "grids-retention-file-"));
    const out = join(dir, "evidence.txt");
    try {
      const download = createContext(["bases", "retention", "files", "download", baseId, fileId], { out }, [
        jsonResponse(basePage),
        new Response("hello"),
      ]);
      await gridsCli.run(download.ctx);
      expect(download.calls.at(-1)?.path).toBe(`/api/grids/bases/${baseId}/retention-policy/files/${fileId}/content`);
      expect(await readFile(out, "utf8")).toBe("hello");
      expect(download.lines).toEqual([`Wrote ${out}.`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("lists trashed Records under a retention floor through public ids", async () => {
    const payload = {
      observedAt: "2026-08-19T12:05:00.000Z",
      minimumDays: 30,
      items: [
        {
          recordId,
          tableId,
          tableName: "Cases",
          status: "retained",
          deletedAt: "2026-08-18T12:05:00.000Z",
          notBefore: "2026-09-17T12:05:00.000Z",
        },
      ],
      pagination: { page: 2, per_page: 10, total: 11, total_pages: 2, has_next: false },
    };
    const list = createContext(
      ["bases", "retention", "records", "list", baseId],
      { days: "30", search: "Cases", status: "retained", page: "2", "per-page": "10" },
      [jsonResponse(basePage), jsonResponse(payload)],
      { output: "json" },
    );
    await gridsCli.run(list.ctx);
    expect(list.calls.at(-1)?.path).toBe(
      `/api/grids/bases/${baseId}/retention-policy/records?minimumDays=30&search=Cases&status=retained&page=2&per_page=10`,
    );
    expect(list.jsonValues).toEqual([payload]);
  });

  test("sets a Base retention floor and confirms only shorter floors", async () => {
    const existing = { baseId, minimumDays: 30, updatedAt: "2026-08-19T12:00:00.000Z" };
    const longer = { ...existing, minimumDays: 60, updatedAt: "2026-08-19T12:10:00.000Z" };
    const update = createContext(
      ["bases", "retention", "set", baseId],
      { days: "60" },
      [jsonResponse(basePage), jsonResponse({ policy: existing }), jsonResponse({ policy: longer })],
      { output: "json" },
    );

    await gridsCli.run(update.ctx);

    expect(update.calls.at(-1)?.init?.method).toBe("PUT");
    expect(JSON.parse(String(update.calls.at(-1)?.init?.body))).toEqual({ minimumDays: 60 });
    expect(update.jsonValues).toEqual([{ policy: longer }]);

    const shorter = createContext(["bases", "retention", "set", baseId], { days: "10" }, [
      jsonResponse(basePage),
      jsonResponse({ policy: existing }),
    ]);
    await expect(gridsCli.run(shorter.ctx)).rejects.toThrow("Pass --yes to shorten the existing retention floor.");
    expect(shorter.calls.at(-1)?.init?.method).toBeUndefined();

    const confirmed = createContext(["bases", "retention", "set", baseId], { days: "10", yes: true }, [
      jsonResponse(basePage),
      jsonResponse({ policy: existing }),
      jsonResponse({ policy: { ...existing, minimumDays: 10 } }),
    ]);
    await gridsCli.run(confirmed.ctx);
    expect(confirmed.calls.at(-1)?.init?.method).toBe("PUT");
  });

  test("requires confirmation before removing a Base retention floor", async () => {
    const unconfirmed = createContext(["bases", "retention", "remove", baseId]);
    await expect(gridsCli.run(unconfirmed.ctx)).rejects.toThrow("Pass --yes to remove the retention floor.");
    expect(unconfirmed.calls).toEqual([]);

    const confirmed = createContext(
      ["bases", "retention", "remove", baseId],
      { yes: true },
      [jsonResponse(basePage), new Response(null, { status: 204 })],
      { output: "json" },
    );
    await gridsCli.run(confirmed.ctx);
    expect(confirmed.calls.at(-1)?.path).toBe(`/api/grids/bases/${baseId}/retention-policy`);
    expect(confirmed.calls.at(-1)?.init?.method).toBe("DELETE");
    expect(confirmed.jsonValues).toEqual([{ removed: true, baseId }]);
  });

  test("previews, starts, inspects, and cancels bounded File destruction", async () => {
    const preview = {
      observedAt: "2026-08-20T08:00:00.000Z",
      minimumDays: 30,
      counts: { total: 2, eligible: 1, retained: 1, held: 0, unknown: 0, eligibleBytes: 18 },
      items: [
        {
          fileId,
          tableId,
          tableName: "Authors",
          filename: "evidence.txt",
          sizeBytes: 18,
          unreferencedAt: "2026-07-01T08:00:00.000Z",
          notBefore: "2026-07-31T08:00:00.000Z",
        },
      ],
      truncated: false,
    };
    const run = {
      id: "DEST01",
      baseId,
      status: "queued",
      requestedByDisplayName: "Base Admin",
      requestedAt: "2026-08-20T08:01:00.000Z",
      startedAt: null,
      completedAt: null,
      counts: { total: 1, processed: 0, destroyed: 0, skipped: 0, failed: 0 },
      items: [
        {
          fileId,
          tableId,
          tableName: "Authors",
          filename: "evidence.txt",
          sizeBytes: 18,
          status: "pending",
          message: null,
        },
      ],
      error: null,
    };
    const overview = { preview, runs: [] };
    const show = createContext(["bases", "destruction", "preview", baseId], {}, [jsonResponse(basePage), jsonResponse(overview)], {
      output: "json",
    });
    await gridsCli.run(show.ctx);
    expect(show.calls.at(-1)?.path).toBe(`/api/grids/bases/${baseId}/controlled-destruction`);
    expect(show.jsonValues).toEqual([preview]);

    const wrong = createContext(["bases", "destruction", "run", baseId], { confirm: "Wrong" }, [jsonResponse(basePage)]);
    await expect(gridsCli.run(wrong.ctx)).rejects.toThrow("--confirm must exactly match the Base name: Bookshop");
    expect(wrong.calls).toHaveLength(1);

    const start = createContext(
      ["bases", "destruction", "run", baseId],
      { confirm: "Bookshop" },
      [jsonResponse(basePage), jsonResponse(overview), jsonResponse(run, 201)],
      { output: "json" },
    );
    await gridsCli.run(start.ctx);
    expect(start.calls.at(-1)?.path).toBe(`/api/grids/bases/${baseId}/controlled-destruction`);
    expect(start.calls.at(-1)?.init?.method).toBe("POST");
    expect(JSON.parse(String(start.calls.at(-1)?.init?.body))).toEqual({
      fileIds: [fileId],
      confirmation: "Bookshop",
    });
    expect(start.jsonValues).toEqual([run]);

    const status = createContext(["bases", "destruction", "status", baseId, run.id], {}, [jsonResponse(basePage), jsonResponse(run)], {
      output: "json",
    });
    await gridsCli.run(status.ctx);
    expect(status.calls.at(-1)?.path).toBe(`/api/grids/bases/${baseId}/controlled-destruction/${run.id}`);
    expect(status.jsonValues).toEqual([run]);

    const unconfirmed = createContext(["bases", "destruction", "cancel", baseId, run.id]);
    await expect(gridsCli.run(unconfirmed.ctx)).rejects.toThrow("Pass --yes to cancel remaining controlled destruction work.");
    expect(unconfirmed.calls).toEqual([]);
    const canceled = { ...run, status: "canceled" };
    const cancel = createContext(
      ["bases", "destruction", "cancel", baseId, run.id],
      { yes: true },
      [jsonResponse(basePage), jsonResponse(canceled)],
      { output: "json" },
    );
    await gridsCli.run(cancel.ctx);
    expect(cancel.calls.at(-1)?.path).toBe(`/api/grids/bases/${baseId}/controlled-destruction/${run.id}/cancel`);
    expect(cancel.calls.at(-1)?.init?.method).toBe("POST");
    expect(cancel.jsonValues).toEqual([canceled]);
  });

  test("creates, filters, and confirms release of preservation holds", async () => {
    const hold = {
      id: "HOLD01",
      baseId,
      reason: "Annual review",
      scope: { type: "base" as const },
      status: "active",
      createdByDisplayName: "Base Admin",
      createdAt: "2026-08-19T16:00:00.000Z",
      releaseReason: null,
      releasedByDisplayName: null,
      releasedAt: null,
    };
    const page = {
      items: [hold],
      pagination: { page: 2, per_page: 10, total: 11, total_pages: 2, has_next: false },
    };
    const list = createContext(
      ["bases", "preservation-holds", "list", baseId],
      { status: "active", page: "2", "per-page": "10" },
      [jsonResponse(basePage), jsonResponse(page)],
      { output: "json" },
    );
    await gridsCli.run(list.ctx);
    expect(list.calls.at(-1)?.path).toBe(`/api/grids/bases/${baseId}/preservation-holds?status=active&scope=all&page=2&per_page=10`);
    expect(list.jsonValues).toEqual([page]);

    const create = createContext(
      ["bases", "preservation-holds", "create", baseId],
      { reason: " Annual review " },
      [jsonResponse(basePage), jsonResponse(hold)],
      { output: "json" },
    );
    await gridsCli.run(create.ctx);
    expect(create.calls.at(-1)?.path).toBe(`/api/grids/bases/${baseId}/preservation-holds`);
    expect(JSON.parse(String(create.calls.at(-1)?.init?.body))).toEqual({ reason: "Annual review", scope: { type: "base" } });
    expect(create.jsonValues).toEqual([hold]);

    const tableHold = {
      ...hold,
      id: "HOLD02",
      reason: "Author dispute",
      scope: { type: "table" as const, tableId, tableName: table.name },
    };
    const createTable = createContext(
      ["bases", "preservation-holds", "create", baseId],
      { scope: "table", table: table.name, reason: " Author dispute " },
      [jsonResponse(basePage), jsonResponse([table]), jsonResponse(tableHold)],
      { output: "json" },
    );
    await gridsCli.run(createTable.ctx);
    expect(createTable.calls.at(-2)?.path).toBe(`/api/grids/tables/by-base/${baseId}?q=Authors&limit=100`);
    expect(JSON.parse(String(createTable.calls.at(-1)?.init?.body))).toEqual({
      reason: "Author dispute",
      scope: { type: "table", tableId },
    });

    const listTable = createContext(
      ["bases", "preservation-holds", "list", baseId],
      { status: "active", scope: "table", table: table.name },
      [
        jsonResponse(basePage),
        jsonResponse([table]),
        jsonResponse({ ...page, items: [tableHold], pagination: { ...page.pagination, total: 1 } }),
      ],
      { output: "json" },
    );
    await gridsCli.run(listTable.ctx);
    expect(listTable.calls.at(-1)?.path).toBe(
      `/api/grids/bases/${baseId}/preservation-holds?status=active&scope=table&tableId=${tableId}&page=1&per_page=25`,
    );

    const historicalJsonl = createContext(
      ["bases", "preservation-holds", "list", baseId],
      { status: "released", scope: "table", table: tableId },
      [jsonResponse(basePage), jsonResponse({ ...page, items: [tableHold] })],
      { output: "jsonl" },
    );
    await gridsCli.run(historicalJsonl.ctx);
    expect(historicalJsonl.calls).toHaveLength(2);
    expect(historicalJsonl.calls.at(-1)?.path).toBe(
      `/api/grids/bases/${baseId}/preservation-holds?status=released&scope=table&tableId=${tableId}&page=1&per_page=25`,
    );
    expect(historicalJsonl.jsonValues).toEqual([tableHold]);

    const internalTableRef = createContext(
      ["bases", "preservation-holds", "create", baseId],
      { scope: "table", table: accessId, reason: "Internal ref" },
      [jsonResponse(basePage)],
      { output: "json" },
    );
    await expect(gridsCli.run(internalTableRef.ctx)).rejects.toThrow("Table references do not accept UUIDs");
    expect(internalTableRef.calls).toHaveLength(1);

    const unconfirmed = createContext(["bases", "preservation-holds", "release", baseId, hold.id], {
      reason: "Review completed",
    });
    await expect(gridsCli.run(unconfirmed.ctx)).rejects.toThrow("Pass --yes to release the preservation hold.");
    expect(unconfirmed.calls).toEqual([]);

    const released = { ...hold, status: "released", releaseReason: "Review completed", releasedAt: "2026-08-19T17:00:00.000Z" };
    const release = createContext(
      ["bases", "preservation-holds", "release", baseId, hold.id],
      { reason: " Review completed ", yes: true },
      [jsonResponse(basePage), jsonResponse(released)],
      { output: "json" },
    );
    await gridsCli.run(release.ctx);
    expect(release.calls.at(-1)?.path).toBe(`/api/grids/bases/${baseId}/preservation-holds/${hold.id}/release`);
    expect(JSON.parse(String(release.calls.at(-1)?.init?.body))).toEqual({ reason: "Review completed" });
    expect(release.jsonValues).toEqual([released]);
  });

  test("forwards public field ids in table and view presentation updates", async () => {
    const tableBody = {
      columns: [{ fieldId }],
      displayConfig: { mode: "cards", cards: { imageFieldId: fieldId, fieldIds: [fieldId] } },
    };
    const tableUpdate = createContext(["tables", "update", baseId, "Authors"], { body: JSON.stringify(tableBody) }, [
      jsonResponse(basePage),
      jsonResponse([table]),
      jsonResponse({ ...table, ...tableBody }),
    ]);
    await gridsCli.run(tableUpdate.ctx);
    expect(tableUpdate.calls.at(-1)?.path).toBe(`/api/grids/tables/${tableId}`);
    expect(tableUpdate.calls.at(-1)?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(tableUpdate.calls.at(-1)?.init?.body))).toEqual(tableBody);

    const viewBody = {
      ui: {
        columns: [{ fieldId }],
        groupedColumnOrder: [`group:0:${fieldId}:year`],
        hiddenGroupedColumns: [`agg:0:${fieldId}:sum`],
      },
    };
    const viewUpdate = createContext(["views", "update", baseId, "Authors", "Recent authors"], { body: JSON.stringify(viewBody) }, [
      jsonResponse(basePage),
      jsonResponse([table]),
      jsonResponse([view]),
      jsonResponse({ ...view, ...viewBody }),
    ]);
    await gridsCli.run(viewUpdate.ctx);
    expect(viewUpdate.calls.at(-1)?.path).toBe(`/api/grids/views/${viewId}`);
    expect(viewUpdate.calls.at(-1)?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(viewUpdate.calls.at(-1)?.init?.body))).toEqual(viewBody);
  });

  test("lists built-in base templates", async () => {
    const template = {
      id: "inventory",
      name: "Inventory",
      description: "Track equipment and loans.",
      highlights: ["Structured inventory", "Operational workflows", "Documents and Grids Apps"],
      icon: "ti ti-packages",
    };
    const { ctx, calls, tables } = createContext(["templates", "list"], {}, [jsonResponse([template])]);

    await gridsCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual(["/api/grids/templates"]);
    expect(tables[0]).toEqual([
      expect.objectContaining({ id: "inventory", name: "Inventory", highlights: expect.stringContaining("Operational workflows") }),
    ]);
  });

  test("instantiates a built-in template as the default base", async () => {
    const template = {
      id: "inventory",
      name: "Inventory",
      description: "Track equipment and loans.",
      highlights: ["Structured inventory", "Operational workflows", "Documents and Grids Apps"],
      icon: "ti ti-packages",
    };
    const { ctx, calls, defaults, lines } = createContext(
      ["templates", "instantiate", "Inventory"],
      { name: "Equipment", empty: true, use: true },
      [jsonResponse([template]), jsonResponse({ ...base, name: "Equipment" }, 201)],
    );

    await gridsCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual(["/api/grids/templates", "/api/grids/templates/inventory"]);
    expect(calls[1]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ name: "Equipment", withSampleData: false });
    expect(defaults["grids.base"]).toBe(base.id);
    expect(lines).toEqual(["Created Equipment (bk001A) from Inventory. Using it as default."]);
  });

  test("lists restorable resources in a base trash", async () => {
    const deletedAt = "2026-07-08T00:00:00.000Z";
    const trash = {
      tables: [{ ...table, deletedAt }],
      fields: [{ ...field, deletedAt }],
      forms: [{ id: formId, tableId, name: "Author intake", deletedAt }],
    };
    const { ctx, calls, tables } = createContext(["bases", "trash", baseId], {}, [jsonResponse(basePage), jsonResponse(trash)]);

    await gridsCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([`/api/grids/bases?q=${baseId}&limit=500&offset=0`, `/api/grids/bases/${baseId}/trash`]);
    expect(tables[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "table", id: tableId }),
        expect.objectContaining({ kind: "field", id: fieldId, parent: tableId }),
        expect.objectContaining({ kind: "form", id: formId, parent: tableId }),
      ]),
    );
  });

  test("executes GQL against the selected base", async () => {
    const query = "from table Authors select Name limit 1";
    const { ctx, calls, tables } = createContext(
      ["gql", "run"],
      { query },
      [
        jsonResponse({ items: [base], total: 1, limit: 500, offset: 0 }),
        jsonResponse({
          ok: true,
          mode: "rows",
          columns: [{ key: "Name", label: "Name", type: "text", sqlType: "text" }],
          rows: [{ recordId, tableId, values: { Name: "Ursula K. Le Guin" } }],
          limit: 100,
          truncated: false,
        }),
      ],
      { defaultBase: "bk001A" },
    );

    const exitCode = await gridsCli.run(ctx);

    expect(exitCode).toBe(0);
    expect(calls.map((call) => call.path)).toEqual([
      "/api/grids/bases?q=bk001A&limit=500&offset=0",
      `/api/grids/gql/by-base/${baseId}/execute`,
    ]);
    expect(calls[1]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ query, pageSize: 100 });
    expect(tables[0]).toEqual([{ recordId, Name: "Ursula K. Le Guin" }]);
  });

  test("prints compiled GQL as one structured JSONL value", async () => {
    const query = "from table Authors select Name";
    const payload = { ok: true as const, tableId, source: "from table #auth1A select #name1A" };
    const { ctx, calls, jsonValues, lines, tables } = createContext(
      ["gql", "compile-view", baseId],
      { query },
      [jsonResponse(basePage), jsonResponse(payload)],
      { output: "jsonl" },
    );

    const exitCode = await gridsCli.run(ctx);

    expect(exitCode).toBe(0);
    expect(calls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/gql/by-base/${baseId}/compile-view`,
    ]);
    expect(jsonValues).toEqual([payload]);
    expect(lines).toEqual([]);
    expect(tables).toEqual([]);
  });

  test("creates schema objects through resolved base and table references", async () => {
    const { ctx, calls, lines } = createContext(
      ["fields", "create", baseId, "Authors"],
      { name: "Birth year", type: "number", config: "{}" },
      [jsonResponse(basePage), jsonResponse([table]), jsonResponse({ ...field, name: "Birth year", type: "number", config: {} }, 201)],
    );

    await gridsCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/tables/by-base/${baseId}`,
      `/api/grids/fields/by-table/${tableId}`,
    ]);
    expect(calls[2]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[2]?.init?.body))).toMatchObject({ name: "Birth year", type: "number", config: {} });
    expect(lines).toEqual(["Created field Birth year (name1A)."]);
  });

  test("lists field type references for agents", async () => {
    const { ctx, tables } = createContext(["fields", "types"]);

    await gridsCli.run(ctx);

    expect(tables[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", category: "value", writable: "yes" }),
        expect.objectContaining({ type: "relation", category: "link", writable: "yes" }),
        expect.objectContaining({ type: "formula", category: "computed", writable: "no" }),
        expect.objectContaining({ type: "html_template", category: "computed", writable: "no" }),
      ]),
    );
  });

  test("shows the HTML template field contract for agents", async () => {
    const { ctx, jsonValues } = createContext(["fields", "type", "html_template"], {}, [], { output: "json" });

    await gridsCli.run(ctx);

    expect(jsonValues[0]).toMatchObject({
      type: "html_template",
      category: "computed",
      recordWritable: false,
      recordValue: "(rendered HTML)",
    });
    expect(JSON.stringify(jsonValues[0])).toContain("record.data.FIELD1");
  });

  test("shows one field type reference as JSON", async () => {
    const { ctx, jsonValues } = createContext(["fields", "type", "select"], {}, [], { output: "json" });

    await gridsCli.run(ctx);

    expect(jsonValues[0]).toMatchObject({
      type: "select",
      category: "value",
      recordWritable: true,
      recordValue: '["open"]',
    });
  });

  test("prints record payload shape from live table fields", async () => {
    const selectField = {
      ...field,
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Country",
      type: "select",
      config: { options: [{ id: "uk", label: "United Kingdom" }] },
      required: true,
    };
    const formulaField = {
      ...field,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: "Name length",
      type: "formula",
      config: { expression: "LEN(Name)" },
    };
    const { ctx, calls, jsonValues } = createContext(
      ["records", "shape", baseId, "Authors"],
      {},
      [jsonResponse(basePage), jsonResponse([table]), jsonResponse([field, selectField, formulaField])],
      { output: "json" },
    );

    await gridsCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/tables/by-base/${baseId}`,
      `/api/grids/fields/by-table/${tableId}`,
    ]);
    expect(jsonValues[0]).toMatchObject({
      table: { id: tableId, name: "Authors" },
      payload: "Record create/update bodies are plain JSON objects keyed by field public id.",
      example: { [fieldId]: "Text value", [selectField.id]: ["uk"] },
      writableFields: expect.arrayContaining([
        expect.objectContaining({ id: fieldId, name: "Name", type: "text" }),
        expect.objectContaining({ id: selectField.id, name: "Country", type: "select", required: true, exampleValue: ["uk"] }),
      ]),
      readOnlyFields: [expect.objectContaining({ id: formulaField.id, name: "Name length", type: "formula" })],
    });
  });

  test("marks Combined table record shapes as read-only", async () => {
    const { ctx, jsonValues } = createContext(
      ["records", "shape", baseId, "All authors"],
      {},
      [jsonResponse(basePage), jsonResponse([combinedTable]), jsonResponse([field])],
      { output: "json" },
    );

    await gridsCli.run(ctx);

    expect(jsonValues[0]).toMatchObject({
      table: { id: combinedTable.id, kind: "federated" },
      payload: "Combined tables are read-only. Query or export their canonical fields instead of sending record payloads.",
      example: {},
      writableFields: [],
      readOnlyFields: [expect.objectContaining({ id: fieldId, name: "Name" })],
    });
  });

  test("validates friendly Combined table mappings through resolved names", async () => {
    const sourceTable = { ...table, id: sourceTableId, name: "Regional authors" };
    const targetField = { ...field, tableId: combinedTable.id };
    const sourceField = { ...field, id: "26262626-2626-4262-8262-262626262626", tableId: sourceTable.id, name: "Display name" };
    const body = {
      sources: [{ base: "Bookshop", table: "Regional authors", mappings: [{ target: "Name", source: "Display name" }] }],
    };
    const { ctx, calls, lines } = createContext(["tables", "combined", "validate", baseId, "All authors"], { body: JSON.stringify(body) }, [
      jsonResponse(basePage),
      jsonResponse([combinedTable]),
      jsonResponse([targetField]),
      jsonResponse({ items: [base], total: 1, limit: 500, offset: 0 }),
      jsonResponse([sourceTable]),
      jsonResponse([sourceField]),
      jsonResponse({ valid: true, diagnostics: [] }),
    ]);

    await gridsCli.run(ctx);

    expect(calls.at(-1)?.path).toBe(`/api/grids/tables/${combinedTable.id}/federation/validate`);
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({
      sourceTableIds: [sourceTable.id],
      mappings: [
        {
          targetFieldId: targetField.id,
          sourceTableId: sourceTable.id,
          sourceFieldId: sourceField.id,
          config: {},
        },
      ],
    });
    expect(lines).toEqual(["Combined table configuration is valid."]);
  });

  test("uses permission-shaped management views for Combined get, draft, and publish", async () => {
    const current = {
      ...combinedDraftView,
      id: "29292929-2929-4292-8292-292929292929",
      revision: 1,
      status: "active" as const,
      publishedAt: "2026-07-17T12:00:00.000Z",
    };
    const get = createContext(
      ["tables", "combined", "get", baseId, "All authors"],
      {},
      [jsonResponse(basePage), jsonResponse([combinedTable]), jsonResponse({ current, draft: combinedDraftView })],
      { output: "json" },
    );

    await gridsCli.run(get.ctx);

    expect(get.calls.at(-1)?.path).toBe(`/api/grids/tables/${combinedTableId}/federation`);
    expect(get.jsonValues[0]).toEqual({ current, draft: combinedDraftView });
    expect((get.jsonValues[0] as { draft: typeof combinedDraftView }).draft.sources[0]).toEqual({
      sourceTableId: null,
      position: 0,
      authorizedAt: "2026-07-17T12:00:00.000Z",
      revokedAt: null,
    });

    const body = { sourceTableIds: [], mappings: [] };
    const draft = createContext(
      ["tables", "combined", "draft", baseId, "All authors"],
      { body: JSON.stringify(body) },
      [
        jsonResponse(basePage),
        jsonResponse([combinedTable]),
        jsonResponse({ current: null, draft: combinedDraftView }),
        jsonResponse(combinedDraftView),
      ],
      { output: "json" },
    );

    await gridsCli.run(draft.ctx);

    expect(draft.calls.at(-1)?.path).toBe(`/api/grids/tables/${combinedTableId}/federation/draft`);
    expect(draft.calls.at(-1)?.init?.method).toBe("PUT");
    expect(JSON.parse(String(draft.calls.at(-1)?.init?.body))).toEqual({
      ...body,
      draftToken: combinedDraftView.revisionToken,
    });
    expect(draft.jsonValues[0]).toEqual(combinedDraftView);

    const published = { ...combinedDraftView, status: "active" as const, publishedAt: "2026-07-18T08:10:00.000Z" };
    const publish = createContext(
      ["tables", "combined", "publish", baseId, "All authors"],
      {},
      [jsonResponse(basePage), jsonResponse([combinedTable]), jsonResponse(published)],
      { output: "json" },
    );

    await gridsCli.run(publish.ctx);

    expect(publish.calls.at(-1)?.path).toBe(`/api/grids/tables/${combinedTableId}/federation/publish`);
    expect(publish.calls.at(-1)?.init?.method).toBe("POST");
    expect(publish.jsonValues[0]).toEqual(published);
  });

  test("rejects internal Combined source-retention ids", async () => {
    const body = { sourceTableIds: [], retainedSourceIds: ["28282828-2828-4282-8282-282828282828"], mappings: [] };
    const { ctx, calls } = createContext(
      ["tables", "combined", "draft", baseId, "All authors"],
      { body: JSON.stringify(body) },
      [jsonResponse(basePage), jsonResponse([combinedTable])],
      { output: "json" },
    );

    await expect(gridsCli.run(ctx)).rejects.toThrow("Invalid Combined table draft");
    expect(calls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/tables/by-base/${baseId}`,
    ]);
  });

  test("lists Combined source candidates and source-admin publications", async () => {
    const sourceTable = { ...table, id: sourceTableId, name: "Regional authors" };
    const candidates = {
      items: [{ base: { id: base.id, name: base.name }, table: sourceTable, fieldCount: 3 }],
      total: 1,
      limit: 25,
      offset: 25,
    };
    const candidateContext = createContext(
      ["tables", "combined", "candidates", baseId, "All authors"],
      { q: "regional", "per-page": "25", page: "2" },
      [jsonResponse(basePage), jsonResponse([combinedTable]), jsonResponse(candidates)],
      { output: "json" },
    );

    await gridsCli.run(candidateContext.ctx);

    expect(candidateContext.calls.at(-1)?.path).toBe(
      `/api/grids/tables/${combinedTableId}/federation/source-candidates?limit=25&offset=25&q=regional`,
    );
    expect(candidateContext.jsonValues[0]).toEqual({
      ...candidates,
      items: [
        {
          base: { id: base.id, name: base.name },
          table: { ...sourceTable, id: sourceTable.id },
          fieldCount: 3,
        },
      ],
    });

    const publications = [
      {
        targetBaseId: baseId,
        targetBaseName: base.name,
        targetTableId: combinedTableId,
        targetTableName: combinedTable.name,
        revision: 1,
        status: "active",
        publishedAt: "2026-07-17T12:00:00.000Z",
        revokedAt: null,
        mappings: [
          {
            sourceFieldId: fieldId,
            sourceFieldName: "Name",
            targetFieldId: fieldId,
            targetFieldName: "Name",
            targetFieldType: "text",
          },
        ],
      },
    ];
    const publicationContext = createContext(
      ["tables", "combined", "publications", baseId, "Regional authors"],
      {},
      [jsonResponse(basePage), jsonResponse([sourceTable]), jsonResponse(publications)],
      { output: "json" },
    );

    await gridsCli.run(publicationContext.ctx);

    expect(publicationContext.calls.at(-1)?.path).toBe(`/api/grids/tables/${sourceTableId}/federation/publications`);
    expect(publicationContext.jsonValues[0]).toEqual(publications);
  });

  test("revokes a Combined publication from the source table with the target public-id flag", async () => {
    const sourceTable = { ...table, id: sourceTableId, name: "Regional authors" };
    const { ctx, calls, lines } = createContext(
      ["tables", "combined", "revoke", baseId, "Regional authors"],
      { "target-table": combinedTableId, yes: true },
      [jsonResponse(basePage), jsonResponse([sourceTable]), new Response(null, { status: 204 })],
    );

    await gridsCli.run(ctx);

    expect(calls.at(-1)?.path).toBe(`/api/grids/tables/${combinedTableId}/federation/sources/${sourceTableId}/revoke`);
    expect(calls.at(-1)?.init?.method).toBe("POST");
    expect(lines).toEqual([`Revoked Regional authors from Combined table ${combinedTableId}.`]);
  });

  test("creates records with raw JSON payloads", async () => {
    const { ctx, calls, lines } = createContext(
      ["records", "create", baseId, "Authors"],
      { body: JSON.stringify({ [fieldId]: "Octavia Butler" }) },
      [jsonResponse(basePage), jsonResponse([table]), jsonResponse({ ...record, data: { [fieldId]: "Octavia Butler" } }, 201)],
    );

    await gridsCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/tables/by-base/${baseId}`,
      `/api/grids/records/by-table/${tableId}`,
    ]);
    expect(calls[2]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ [fieldId]: "Octavia Butler" });
    expect(lines).toEqual([`Created record ${recordId}.`]);
  });

  test("shows and fully enables durable table history", async () => {
    const disabled = createContext(
      ["tables", "history", baseId, "Authors"],
      {},
      [jsonResponse(basePage), jsonResponse([table]), jsonResponse({ enabled: false })],
      { output: "json" },
    );

    await gridsCli.run(disabled.ctx);

    expect(disabled.calls.at(-1)?.path).toBe(`/api/grids/tables/${tableId}/durable-history`);
    expect(disabled.jsonValues).toEqual([{ enabled: false }]);

    const activating = {
      enabled: true,
      status: "activating",
      activatedAt: "2026-07-20T10:00:00.000Z",
      baselineCompletedAt: null,
      baseline: { captured: 100, total: 125 },
    };
    const active = {
      ...activating,
      status: "active",
      baselineCompletedAt: "2026-07-20T10:01:00.000Z",
      baseline: { captured: 125, total: 125 },
    };
    const enabled = createContext(
      ["tables", "history", "enable", baseId, "Authors"],
      { yes: true },
      [jsonResponse(basePage), jsonResponse([table]), jsonResponse(activating), jsonResponse(active)],
      { output: "json" },
    );

    await gridsCli.run(enabled.ctx);

    expect(enabled.calls.slice(2).map((call) => [call.path, call.init?.method])).toEqual([
      [`/api/grids/tables/${tableId}/durable-history/enable`, "POST"],
      [`/api/grids/tables/${tableId}/durable-history/continue`, "POST"],
    ]);
    expect(enabled.jsonValues).toEqual([active]);
  });

  test("shows and previews a table mutation policy through public ids", async () => {
    const show = createContext(["tables", "mutation-policy", baseId, "Authors"], {}, [jsonResponse(basePage), jsonResponse([table])], {
      output: "json",
    });

    await gridsCli.run(show.ctx);

    expect(show.jsonValues).toEqual([{ mode: "all" }]);

    const impact = {
      items: [{ kind: "form", id: formId, name: "Author intake" }],
      total: 1,
      limit: 50,
      truncated: false,
      complete: true,
    };
    const preview = createContext(
      ["tables", "mutation-policy", "impact", baseId, "Authors"],
      { allow: "direct,form" },
      [jsonResponse(basePage), jsonResponse([table]), jsonResponse(impact)],
      { output: "json" },
    );

    await gridsCli.run(preview.ctx);

    expect(preview.calls.at(-1)?.path).toBe(`/api/grids/tables/${tableId}/mutation-policy/impact`);
    expect(preview.calls.at(-1)?.init?.method).toBe("POST");
    expect(JSON.parse(String(preview.calls.at(-1)?.init?.body))).toEqual({
      policy: { mode: "selected", sources: ["direct", "form"] },
    });
    expect(preview.jsonValues).toEqual([impact]);
  });

  test("sets a table mutation policy and requires confirmation to freeze changes", async () => {
    const policy = { mode: "selected" as const, sources: ["direct" as const] };
    const update = createContext(
      ["tables", "mutation-policy", "set", baseId, "Authors"],
      { allow: "direct" },
      [jsonResponse(basePage), jsonResponse([table]), jsonResponse({ policy })],
      { output: "json" },
    );

    await gridsCli.run(update.ctx);

    expect(update.calls.at(-1)?.path).toBe(`/api/grids/tables/${tableId}/mutation-policy`);
    expect(update.calls.at(-1)?.init?.method).toBe("PUT");
    expect(JSON.parse(String(update.calls.at(-1)?.init?.body))).toEqual({ policy });
    expect(update.jsonValues).toEqual([{ policy }]);

    const freeze = createContext(["tables", "mutation-policy", "set", baseId, "Authors"], { allow: "none" });
    await expect(gridsCli.run(freeze.ctx)).rejects.toThrow("Pass --yes with --allow none to freeze all record changes.");
    expect(freeze.calls).toHaveLength(0);

    const frozenPolicy = { mode: "selected" as const, sources: [] };
    const confirmedFreeze = createContext(
      ["tables", "mutation-policy", "set", baseId, "Authors"],
      { allow: "none", yes: true },
      [jsonResponse(basePage), jsonResponse([table]), jsonResponse({ policy: frozenPolicy })],
      { output: "json" },
    );
    await gridsCli.run(confirmedFreeze.ctx);
    expect(JSON.parse(String(confirmedFreeze.calls.at(-1)?.init?.body))).toEqual({ policy: frozenPolicy, confirmFreeze: true });
    expect(confirmedFreeze.jsonValues).toEqual([{ policy: frozenPolicy }]);
  });

  test("manages table finalization and finalizes records through public ids", async () => {
    const disabledStatus = { enabled: false, durableHistory: "active" as const };
    const enabledStatus = {
      enabled: true,
      durableHistory: "active" as const,
      enabledAt: "2026-08-18T12:00:00.000Z",
      finalizedCount: 0,
      canDisable: true,
    };
    const status = createContext(
      ["tables", "finalization", baseId, "Authors"],
      {},
      [jsonResponse(basePage), jsonResponse([table]), jsonResponse(disabledStatus)],
      { output: "json" },
    );
    await gridsCli.run(status.ctx);
    expect(status.calls.at(-1)?.path).toBe(`/api/grids/tables/${tableId}/finalization`);
    expect(status.jsonValues).toEqual([disabledStatus]);

    const enable = createContext(
      ["tables", "finalization", "enable", baseId, "Authors"],
      { yes: true },
      [jsonResponse(basePage), jsonResponse([table]), jsonResponse(enabledStatus)],
      { output: "json" },
    );
    await gridsCli.run(enable.ctx);
    expect(enable.calls.at(-1)?.path).toBe(`/api/grids/tables/${tableId}/finalization/enable`);
    expect(enable.calls.at(-1)?.init?.method).toBe("POST");
    expect(enable.jsonValues).toEqual([enabledStatus]);

    const finalizedRecord = { ...record, finalizedAt: "2026-08-18T12:01:00.000Z", finalizedBy: null };
    const finalize = createContext(
      ["records", "finalize", baseId, "Authors", recordId],
      { yes: true },
      [jsonResponse(basePage), jsonResponse([table]), jsonResponse(finalizedRecord)],
      { output: "json" },
    );
    await gridsCli.run(finalize.ctx);
    expect(finalize.calls.at(-1)?.path).toBe(`/api/grids/records/${tableId}/${recordId}/finalize`);
    expect(finalize.calls.at(-1)?.init?.method).toBe("POST");
    expect(finalize.jsonValues).toEqual([finalizedRecord]);

    const missingConfirmation = createContext(["records", "finalize", baseId, "Authors", recordId]);
    await expect(gridsCli.run(missingConfirmation.ctx)).rejects.toThrow("Pass --yes to permanently finalize the record.");
    expect(missingConfirmation.calls).toHaveLength(0);
  });

  test("lists durable record versions and downloads retained files", async () => {
    const revisionId = "rev001";
    const revisionPage = {
      status: {
        enabled: true,
        status: "active",
        activatedAt: "2026-07-20T10:00:00.000Z",
        baselineCompletedAt: "2026-07-20T10:01:00.000Z",
        baseline: { captured: 1, total: 1 },
      },
      items: [
        {
          id: revisionId,
          revision: 2,
          action: "updated",
          recordVersion: 2,
          data: { [fieldId]: "Octavia E. Butler" },
          files: [
            {
              id: fileId,
              fieldId,
              position: 0,
              filename: "cover.txt",
              mimeType: "text/plain",
              sizeBytes: 5,
              sha256: "abc123",
            },
          ],
          changedFieldIds: [fieldId],
          deletedAt: null,
          actorDisplayName: "Ada",
          actorAvatarHash: null,
          createdAt: "2026-07-20T10:02:00.000Z",
          fields: [],
        },
      ],
      nextCursor: "rev000",
    };
    const listed = createContext(
      ["records", "versions", baseId, "Authors", recordId],
      { limit: "10", cursor: "rev010" },
      [jsonResponse(basePage), jsonResponse([table]), jsonResponse(revisionPage)],
      { output: "json" },
    );

    await gridsCli.run(listed.ctx);

    expect(listed.calls.at(-1)?.path).toBe(`/api/grids/records/${tableId}/${recordId}/versions?cursor=rev010&limit=10`);
    expect(listed.jsonValues).toEqual([revisionPage]);

    const dir = await mkdtemp(join(tmpdir(), "grids-cli-version-"));
    const out = join(dir, "cover.txt");
    try {
      const downloaded = createContext(["records", "versions", "download", baseId, "Authors", recordId, revisionId, fileId], { out }, [
        jsonResponse(basePage),
        jsonResponse([table]),
        new Response("hello"),
      ]);

      await gridsCli.run(downloaded.ctx);

      expect(downloaded.calls.at(-1)?.path).toBe(`/api/grids/records/${tableId}/${recordId}/versions/${revisionId}/files/${fileId}`);
      expect(await readFile(out, "utf8")).toBe("hello");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loads a deleted record explicitly", async () => {
    const { ctx, calls } = createContext(["records", "get", baseId, "Authors", recordId], { "deleted-only": true }, [
      jsonResponse(basePage),
      jsonResponse([table]),
      jsonResponse({ ...record, deletedAt: "2026-07-20T10:00:00.000Z" }),
    ]);

    await gridsCli.run(ctx);

    expect(calls.at(-1)?.path).toBe(`/api/grids/records/${tableId}/${recordId}?deletedOnly=true`);
  });

  test("sends audit answers through update, trash, and restore contracts", async () => {
    const audit = { [auditQuestionId]: "Annual inventory review" };
    const update = createContext(
      ["records", "update", baseId, "Authors", recordId],
      { body: JSON.stringify({ [fieldId]: "Octavia Butler" }), audit: JSON.stringify(audit) },
      [jsonResponse(basePage), jsonResponse([table]), jsonResponse({ ...record, data: { [fieldId]: "Octavia Butler" } })],
    );

    await gridsCli.run(update.ctx);

    expect(update.calls[2]?.path).toBe(`/api/grids/records/${tableId}/${recordId}`);
    expect(update.calls[2]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(update.calls[2]?.init?.body))).toEqual({
      values: { [fieldId]: "Octavia Butler" },
      audit: { answers: audit },
    });

    const remove = createContext(["records", "delete", baseId, "Authors", recordId], { audit: JSON.stringify(audit), yes: true }, [
      jsonResponse(basePage),
      jsonResponse([table]),
      new Response(null, { status: 204 }),
    ]);

    await gridsCli.run(remove.ctx);

    expect(remove.calls[2]?.path).toBe(`/api/grids/records/${tableId}/${recordId}/trash`);
    expect(remove.calls[2]?.init?.method).toBe("POST");
    expect(JSON.parse(String(remove.calls[2]?.init?.body))).toEqual({ audit: { answers: audit } });

    const restore = createContext(["records", "restore", baseId, "Authors", recordId], { audit: JSON.stringify(audit) }, [
      jsonResponse(basePage),
      jsonResponse([table]),
      new Response(null, { status: 204 }),
    ]);

    await gridsCli.run(restore.ctx);

    expect(restore.calls[2]?.path).toBe(`/api/grids/records/${tableId}/${recordId}/restore`);
    expect(restore.calls[2]?.init?.method).toBe("POST");
    expect(JSON.parse(String(restore.calls[2]?.init?.body))).toEqual({ audit: { answers: audit } });
  });

  test("browses Combined audit entries with server-side filters and cursors", async () => {
    const payload = {
      items: [
        {
          id: "45454545-4545-4545-8545-454545454545",
          baseId,
          tableId: combinedTableId,
          recordId,
          userId: null,
          userDisplayName: null,
          action: "deleted",
          diff: null,
          context: {
            operation: "delete",
            answers: [{ label: "Deletion reason", type: "longtext", required: true, value: "Retired" }],
          },
          ip: null,
          userAgent: null,
          createdAt: "2026-07-20T10:00:00.000Z",
          source: { ref: "0", baseName: "Regional inventory", tableName: "Items" },
          recordDeletedAt: "2026-07-20T10:00:00.000Z",
        },
      ],
      sources: [{ ref: "0", baseName: "Regional inventory", tableName: "Items" }],
      nextCursor: "next-page",
    };
    const { ctx, calls, jsonValues } = createContext(
      ["records", "audit", "list", baseId, "All authors"],
      { action: "deleted", source: "0", cursor: "current-page", limit: "25" },
      [jsonResponse(basePage), jsonResponse([combinedTable]), jsonResponse(payload)],
      { output: "json" },
    );

    await gridsCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/tables/by-base/${baseId}`,
      `/api/grids/records/by-table/${combinedTableId}/audit?sourceRef=0&action=deleted&cursor=current-page&limit=25`,
    ]);
    expect(jsonValues).toEqual([payload]);
  });

  test("shows declared audit answers in the default Combined audit table", async () => {
    const payload = {
      items: [
        {
          id: "45454545-4545-4545-8545-454545454545",
          baseId,
          tableId: combinedTableId,
          recordId,
          userId: null,
          userDisplayName: null,
          action: "deleted",
          diff: { [fieldId]: { old: "Camera", new: null } },
          context: {
            operation: "delete",
            answers: [{ label: "Deletion reason", type: "longtext", required: true, value: "Retired" }],
          },
          ip: null,
          userAgent: null,
          createdAt: "2026-07-20T10:00:00.000Z",
          source: { ref: "0", baseName: "Regional inventory", tableName: "Items" },
          recordDeletedAt: "2026-07-20T10:00:00.000Z",
        },
      ],
      sources: [],
      nextCursor: null,
    };
    const { ctx, tables } = createContext(["records", "audit", "list", baseId, "All authors"], {}, [
      jsonResponse(basePage),
      jsonResponse([combinedTable]),
      jsonResponse(payload),
    ]);

    await gridsCli.run(ctx);

    expect(tables[0]?.[0]).toMatchObject({
      answers: "Deletion reason: Retired",
      changes: 1,
    });
  });

  test("imports records atomically through the backend import endpoint", async () => {
    const body = [{ [fieldId]: "Octavia Butler" }];
    const { ctx, calls, tables } = createContext(["records", "import", baseId, "Authors"], { body: JSON.stringify(body) }, [
      jsonResponse(basePage),
      jsonResponse([table]),
      jsonResponse({ items: [{ ...record, data: body[0] }] }, 201),
    ]);

    await gridsCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/tables/by-base/${baseId}`,
      `/api/grids/records/by-table/${tableId}/import`,
    ]);
    expect(calls[2]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ items: body });
    expect(tables[0]?.[0]).toMatchObject({ id: recordId, [fieldId]: "Octavia Butler" });
  });

  test("exports records to a requested output file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grids-cli-export-"));
    const out = join(dir, "authors.json");
    try {
      const { ctx, calls, lines } = createContext(["records", "export", baseId, "Authors"], { format: "json", limit: "50", out }, [
        jsonResponse(basePage),
        jsonResponse([table]),
        new Response("[]", { headers: { "Content-Type": "application/json" } }),
      ]);

      await gridsCli.run(ctx);

      expect(calls.map((call) => call.path)).toEqual([
        `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
        `/api/grids/tables/by-base/${baseId}`,
        `/api/grids/records/by-table/${tableId}/export`,
      ]);
      expect(calls[2]?.init?.method).toBe("POST");
      expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ format: "json", query: { limit: 50 } });
      expect(lines).toEqual([`Wrote ${out}.`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("manages record file-field blobs", async () => {
    const {
      ctx: listCtx,
      calls: listCalls,
      tables,
    } = createContext(["records", "files", "list", baseId, "Authors", recordId, "Name"], {}, [
      jsonResponse(basePage),
      jsonResponse([table]),
      jsonResponse([field]),
      jsonResponse({ items: [gridFile] }),
    ]);

    await gridsCli.run(listCtx);

    expect(listCalls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/tables/by-base/${baseId}`,
      `/api/grids/fields/by-table/${tableId}`,
      `/api/grids/records/${tableId}/${recordId}/files/${fieldId}`,
    ]);
    expect(tables[0]?.[0]).toMatchObject({ id: fileId, filename: "cover.txt", mimeType: "text/plain" });

    const dir = await mkdtemp(join(tmpdir(), "grids-cli-file-"));
    const source = join(dir, "cover.txt");
    const out = join(dir, "cover-copy.txt");
    await writeFile(source, "hello");
    try {
      const {
        ctx: uploadCtx,
        calls: uploadCalls,
        lines: uploadLines,
      } = createContext(["records", "files", "upload", baseId, "Authors", recordId, "Name", source], {}, [
        jsonResponse(basePage),
        jsonResponse([table]),
        jsonResponse([field]),
        jsonResponse(gridFile, 201),
      ]);

      await gridsCli.run(uploadCtx);

      expect(uploadCalls.map((call) => call.path)).toEqual([
        `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
        `/api/grids/tables/by-base/${baseId}`,
        `/api/grids/fields/by-table/${tableId}`,
        `/api/grids/records/${tableId}/${recordId}/files/${fieldId}`,
      ]);
      expect(uploadCalls[3]?.init?.method).toBe("POST");
      const form = uploadCalls[3]?.init?.body as FormData;
      const file = form.get("file") as File;
      expect(file.name).toBe("cover.txt");
      expect(await file.text()).toBe("hello");
      expect(uploadLines).toEqual([`Uploaded cover.txt (${fileId}).`]);

      const {
        ctx: downloadCtx,
        calls: downloadCalls,
        lines: downloadLines,
      } = createContext(["records", "files", "download", baseId, "Authors", recordId, "Name", fileId], { out }, [
        jsonResponse(basePage),
        jsonResponse([table]),
        jsonResponse([field]),
        new Response("hello"),
      ]);

      await gridsCli.run(downloadCtx);

      expect(downloadCalls.map((call) => call.path)).toEqual([
        `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
        `/api/grids/tables/by-base/${baseId}`,
        `/api/grids/fields/by-table/${tableId}`,
        `/api/grids/records/${tableId}/${recordId}/files/${fieldId}/${fileId}/content`,
      ]);
      expect(await readFile(out, "utf8")).toBe("hello");
      expect(downloadLines).toEqual([`Wrote ${out}.`]);

      const {
        ctx: deleteCtx,
        calls: deleteCalls,
        lines: deleteLines,
      } = createContext(["records", "files", "delete", baseId, "Authors", recordId, "Name", fileId], { yes: true }, [
        jsonResponse(basePage),
        jsonResponse([table]),
        jsonResponse([field]),
        new Response(null, { status: 204 }),
      ]);

      await gridsCli.run(deleteCtx);

      expect(deleteCalls.map((call) => call.path)).toEqual([
        `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
        `/api/grids/tables/by-base/${baseId}`,
        `/api/grids/fields/by-table/${tableId}`,
        `/api/grids/records/${tableId}/${recordId}/files/${fieldId}/${fileId}`,
      ]);
      expect(deleteCalls[3]?.init?.method).toBe("DELETE");
      expect(deleteLines).toEqual([`Removed attachment ${fileId} from the current record.`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("record create help points agents to the shape command", async () => {
    const { ctx, lines } = createContext(["records", "create", "help"]);

    await gridsCli.run(ctx);

    expect(lines[0]).toContain("cld grids records shape Bookshop Authors --json");
    expect(lines[0]).toContain("Pass a JSON object keyed by field public id.");
  });

  test("prints agent-ready references for GQL, formulas, templates, and workflows", async () => {
    const gql = createContext(["gql", "reference"], {}, [], { output: "json" });
    const formulas = createContext(["formulas", "reference"], {}, [], { output: "json" });
    const documents = createContext(["document-templates", "reference"], {}, [], { output: "json" });
    const email = createContext(["email-templates", "reference"], {}, [], { output: "json" });
    const workflows = createContext(["workflows", "reference"], {}, [], { output: "json" });

    await gridsCli.run(gql.ctx);
    await gridsCli.run(formulas.ctx);
    await gridsCli.run(documents.ctx);
    await gridsCli.run(email.ctx);
    await gridsCli.run(workflows.ctx);

    expect(gql.jsonValues[0]).toMatchObject({ clauses: expect.arrayContaining(["from table <table-ref> [as alias]"]) });
    expect(formulas.jsonValues[0]).toMatchObject({
      functions: expect.arrayContaining([expect.objectContaining({ name: "LEN", signature: "LEN(text)" })]),
    });
    expect(documents.jsonValues[0]).toMatchObject({
      liquidData: expect.arrayContaining(["record.id", "document.number", "business.legalName"]),
    });
    expect(email.jsonValues[0]).toMatchObject({
      fields: expect.objectContaining({ html: "Liquid HTML email body. There is no plain-text fallback field." }),
    });
    const workflowReference = structuredClone(workflows.jsonValues[0]);
    expect(workflowReference).toMatchObject({
      language: expect.objectContaining({
        limits: expect.objectContaining({ maxSteps: 1_000, maxLoopItems: 10_000 }),
        inputs: expect.arrayContaining([expect.objectContaining({ kind: "record", config: expect.any(Object) })]),
        triggers: expect.arrayContaining([expect.objectContaining({ kind: "schedule", config: expect.any(Object) })]),
        actions: expect.arrayContaining([
          expect.objectContaining({ kind: "httpRequest", effect: "ambiguous-external", dryRun: "validate" }),
        ]),
      }),
      values: expect.objectContaining({
        dynamic: expect.stringContaining("${{ inputs.name }}"),
        dedicatedReferences: expect.stringContaining("record: inputs.item"),
      }),
      example: expect.stringContaining("value: ${{ now() }}"),
    });
    expect((email.jsonValues[0] as { example: { step: string } }).example.step).toContain("email: ${{ inputs.email }}");
  });

  test("checks formulas through the backend compiler", async () => {
    const { ctx, calls, tables } = createContext(["formulas", "check", baseId, "Authors"], { expression: "LEN(Name)" }, [
      jsonResponse(basePage),
      jsonResponse([table]),
      jsonResponse({
        ok: true,
        diagnostics: [],
        fields: [field],
        rows: [{ recordId, values: { [fieldId]: "Ursula K. Le Guin" }, result: 18 }],
      }),
    ]);

    const exitCode = await gridsCli.run(ctx);

    expect(exitCode).toBe(0);
    expect(calls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/tables/by-base/${baseId}`,
      `/api/grids/formulas/by-table/${tableId}/check`,
    ]);
    expect(calls[2]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ expression: "LEN(Name)" });
    expect(tables[0]).toEqual([{ recordId, result: "18" }]);
  });

  test("creates GQL-backed views", async () => {
    const { ctx, calls, lines } = createContext(
      ["views", "create", baseId, "Authors"],
      { name: "Recent authors", source: "from table Authors" },
      [jsonResponse(basePage), jsonResponse([table]), jsonResponse(view, 201)],
    );

    await gridsCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/tables/by-base/${baseId}`,
      `/api/grids/views/by-table/${tableId}`,
    ]);
    expect(calls[2]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({
      name: "Recent authors",
      source: "from table Authors",
    });
    expect(lines).toEqual(["Created view Recent authors (view1A)."]);
  });

  test("exposes forms and Apps in top-level help", async () => {
    const { ctx, lines } = createContext(["help"]);

    await gridsCli.run(ctx);

    expect(lines[0]).toContain("access");
    expect(lines[0]).toContain("formulas");
    expect(lines[0]).toContain("forms");
    expect(lines[0]).toContain("apps");
    expect(lines[0]).toContain("templates");
    expect(lines[0]).toContain("documents");
    expect(lines[0]).toContain("snapshots");
  });

  test("sets direct Base access", async () => {
    const { ctx, calls, lines } = createContext(
      ["access", "set", "base", baseId],
      { user: accessEntry.principal.userId, permission: "write" },
      [jsonResponse(basePage), jsonResponse([accessEntry]), new Response(null, { status: 204 })],
    );

    await gridsCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/access/by-base/${baseId}`,
      `/api/grids/access/${accessId}`,
    ]);
    expect(calls[2]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ permission: "write" });
    expect(lines).toEqual([`Updated ${accessId} to write.`]);
  });

  test("grants public read access to a Grids App", async () => {
    const { ctx, calls, lines } = createContext(
      ["access", "grant", "app", baseId, "Public catalog"],
      { public: true, permission: "read" },
      [jsonResponse(basePage), jsonResponse([customApp]), jsonResponse({ accessId }, 201)],
    );

    await gridsCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/apps/by-base/${baseId}`,
      `/api/grids/access/by-custom-app/${customAppId}`,
    ]);
    expect(calls[2]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({
      principal: { type: "public" },
      permission: "read",
    });
    expect(lines).toEqual(["Granted read on Public catalog (app01A)."]);
  });

  test("documents resource-specific access principals", async () => {
    const { ctx, jsonValues } = createContext(["access", "reference"], {}, [], { output: "json" });

    await gridsCli.run(ctx);

    expect(jsonValues[0]).toMatchObject({
      resourceTypes: [
        { type: "base", principals: ["user", "group", "service_account", "authenticated"] },
        { type: "app", principals: ["user", "group", "authenticated", "public"] },
      ],
    });
  });

  test("creates custom forms for resolved tables", async () => {
    const { ctx, calls, lines } = createContext(
      ["forms", "create", baseId, "Authors"],
      { name: "Author intake", config: JSON.stringify(form.config), public: true },
      [jsonResponse(basePage), jsonResponse([table]), jsonResponse({ ...form, publicToken: "pub_test" }, 201)],
    );

    await gridsCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/tables/by-base/${baseId}`,
      `/api/grids/forms/by-table/${tableId}`,
    ]);
    expect(calls[2]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({
      name: "Author intake",
      config: form.config,
      isPublic: true,
    });
    expect(lines).toEqual(["Created form Author intake (frm01A)."]);
  });

  test("submits forms through resolved table-scoped names", async () => {
    const { ctx, calls, lines } = createContext(
      ["forms", "submit", baseId, "Authors", "Author intake"],
      { body: JSON.stringify({ [fieldId]: "N. K. Jemisin" }) },
      [jsonResponse(basePage), jsonResponse([table]), jsonResponse([form]), jsonResponse({ recordId }, 201)],
    );

    await gridsCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/tables/by-base/${baseId}`,
      `/api/grids/forms/by-table/${tableId}`,
      `/api/grids/forms/${formId}/submit`,
    ]);
    expect(calls[3]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[3]?.init?.body))).toEqual({ [fieldId]: "N. K. Jemisin" });
    expect(lines).toEqual([`Created record ${recordId}.`]);
  });

  test("rejects form UUID references", async () => {
    const uuid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const { ctx } = createContext(["forms", "get", baseId], { table: "Authors", form: uuid }, [
      jsonResponse(basePage),
      jsonResponse([table]),
      jsonResponse([form]),
    ]);

    await expect(gridsCli.run(ctx)).rejects.toThrow("form references do not accept UUIDs");
  });

  test("creates document templates for resolved tables", async () => {
    const { ctx, calls, lines } = createContext(
      ["document-templates", "create", baseId, "Authors"],
      { name: "Invoice", source: documentTemplate.source, html: documentTemplate.html },
      [jsonResponse(basePage), jsonResponse([table]), jsonResponse(documentTemplate, 201)],
    );

    await gridsCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/tables/by-base/${baseId}`,
      `/api/grids/documents/templates/by-table/${tableId}`,
    ]);
    expect(calls[2]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[2]?.init?.body))).toMatchObject({
      name: "Invoice",
      source: documentTemplate.source,
      html: documentTemplate.html,
    });
    expect(lines).toEqual(["Created document template Invoice (doc01A)."]);
  });

  test("resolves document template names through table-scoped admin lists", async () => {
    const { ctx, calls, jsonValues } = createContext(
      ["document-templates", "get", baseId, "Authors", "Invoice"],
      {},
      [jsonResponse(basePage), jsonResponse([table]), jsonResponse([documentTemplate])],
      { output: "json" },
    );

    await gridsCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/tables/by-base/${baseId}`,
      `/api/grids/documents/templates/by-table/${tableId}/full`,
    ]);
    expect(jsonValues).toEqual([{ ...documentTemplate, id: documentTemplate.id }]);
  });

  test("generates stored documents from document templates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grids-cli-document-"));
    const out = join(dir, "invoice.pdf");
    try {
      const { ctx, calls, lines } = createContext(
        ["documents", "generate", baseId, "Authors", "Invoice"],
        { record: recordId, tag: ["invoice"], out },
        [jsonResponse(basePage), jsonResponse([table]), jsonResponse([documentTemplate]), new Response("PDF")],
      );

      await gridsCli.run(ctx);

      expect(calls.map((call) => call.path)).toEqual([
        `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
        `/api/grids/tables/by-base/${baseId}`,
        `/api/grids/documents/templates/by-table/${tableId}/full`,
        `/api/grids/documents/templates/${documentTemplateId}/generate`,
      ]);
      expect(calls[3]?.init?.method).toBe("POST");
      expect(JSON.parse(String(calls[3]?.init?.body))).toEqual({ recordId, tags: ["invoice"] });
      expect(lines).toEqual([`Wrote ${out}.`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("previews unsaved document template drafts as data", async () => {
    const { ctx, calls, jsonValues } = createContext(
      ["document-templates", "preview-draft-data", baseId, "Authors"],
      { record: recordId, source: documentTemplate.source, html: documentTemplate.html },
      [
        jsonResponse(basePage),
        jsonResponse([table]),
        jsonResponse({ html: "<p>Rendered</p>", data: { record: { id: recordId } }, columns: [], rows: [] }),
      ],
      { output: "json" },
    );

    await gridsCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/tables/by-base/${baseId}`,
      `/api/grids/documents/templates/by-table/${tableId}/preview-data-draft`,
    ]);
    expect(calls[2]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[2]?.init?.body))).toMatchObject({
      recordId,
      source: documentTemplate.source,
      html: documentTemplate.html,
    });
    expect(jsonValues[0]).toMatchObject({ html: "<p>Rendered</p>" });
  });

  test("previews saved document template drafts as PDFs with override output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grids-cli-draft-pdf-"));
    const out = join(dir, "draft.pdf");
    try {
      const { ctx, calls, lines } = createContext(
        ["document-templates", "preview-draft-pdf", baseId, "Authors", "Invoice"],
        { record: recordId, out, html: "<p>{{ record.id }}</p>" },
        [jsonResponse(basePage), jsonResponse([table]), jsonResponse([documentTemplate]), new Response("PDF")],
      );

      await gridsCli.run(ctx);

      expect(calls.map((call) => call.path)).toEqual([
        `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
        `/api/grids/tables/by-base/${baseId}`,
        `/api/grids/documents/templates/by-table/${tableId}/full`,
        `/api/grids/documents/templates/${documentTemplateId}/preview-draft`,
      ]);
      expect(calls[3]?.init?.method).toBe("POST");
      expect(JSON.parse(String(calls[3]?.init?.body))).toMatchObject({
        recordId,
        source: documentTemplate.source,
        html: "<p>{{ record.id }}</p>",
        numberTemplate: documentTemplate.numberTemplate,
        filenameTemplate: documentTemplate.filenameTemplate,
      });
      expect(await readFile(out, "utf8")).toBe("PDF");
      expect(lines).toEqual([`Wrote ${out}.`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("lists and updates generated document runs", async () => {
    const {
      ctx: listCtx,
      calls: listCalls,
      tables,
    } = createContext(["documents", "list", baseId, "Authors", "Invoice"], { tag: ["invoice"], limit: "25" }, [
      jsonResponse(basePage),
      jsonResponse([table]),
      jsonResponse([documentTemplate]),
      jsonResponse({ items: [documentRun], limit: 25 }),
    ]);

    await gridsCli.run(listCtx);

    expect(listCalls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/tables/by-base/${baseId}`,
      `/api/grids/documents/templates/by-table/${tableId}/full`,
      `/api/grids/documents/runs/by-template/${documentTemplateId}?tags=invoice&limit=25`,
    ]);
    expect(tables[0]?.[0]).toMatchObject({ id: "run01A", filename: "invoice.pdf" });

    const {
      ctx: updateCtx,
      calls: updateCalls,
      lines,
    } = createContext(["documents", "update", documentRunId], { filename: "invoice-final.pdf", tag: ["final"] }, [
      jsonResponse({ ...documentRun, filename: "invoice-final.pdf", tags: ["final"] }),
    ]);

    await gridsCli.run(updateCtx);

    expect(updateCalls.map((call) => call.path)).toEqual([`/api/grids/documents/runs/${documentRunId}`]);
    expect(updateCalls[0]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(updateCalls[0]?.init?.body))).toEqual({ filename: "invoice-final.pdf", tags: ["final"] });
    expect(lines).toEqual(["Updated document invoice-final.pdf."]);
  });

  test("creates public links for generated documents", async () => {
    const { ctx, calls, lines } = createContext(
      ["documents", "links", "create", documentRunId],
      { "expires-in": "7d", comment: "Customer download" },
      [jsonResponse({ link: documentLink, url: "https://cloud.test/d/doc-token" }, 201)],
    );

    await gridsCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([`/api/grids/documents/runs/${documentRunId}/links`]);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ expiresIn: "7d", comment: "Customer download" });
    expect(lines).toEqual(["https://cloud.test/d/doc-token"]);
  });

  test("creates, lists, and reads manual record snapshots", async () => {
    const {
      ctx: createCtx,
      calls: createCalls,
      lines: createLines,
    } = createContext(["snapshots", "create", baseId, "Authors", recordId], {}, [
      jsonResponse(basePage),
      jsonResponse([table]),
      jsonResponse({ snapshot: recordSnapshot }, 201),
    ]);

    await gridsCli.run(createCtx);

    expect(createCalls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/tables/by-base/${baseId}`,
      `/api/grids/documents/snapshots/by-record/${tableId}/${recordId}`,
    ]);
    expect(createCalls[2]?.init?.method).toBe("POST");
    expect(createLines).toEqual([`Created snapshot ${snapshotId}.`]);

    const {
      ctx: listCtx,
      calls: listCalls,
      tables,
    } = createContext(["snapshots", "list", baseId, "Authors", recordId], {}, [
      jsonResponse(basePage),
      jsonResponse([table]),
      jsonResponse({ items: [recordSnapshot] }),
    ]);

    await gridsCli.run(listCtx);

    expect(listCalls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/tables/by-base/${baseId}`,
      `/api/grids/documents/snapshots/by-record/${tableId}/${recordId}`,
    ]);
    expect(tables[0]?.[0]).toMatchObject({ id: snapshotId, recordId, tableId });

    const {
      ctx: getCtx,
      calls: getCalls,
      jsonValues,
    } = createContext(["snapshots", "get", snapshotId], {}, [jsonResponse(recordSnapshot)], {
      output: "json",
    });

    await gridsCli.run(getCtx);

    expect(getCalls.map((call) => call.path)).toEqual([`/api/grids/documents/snapshots/${snapshotId}`]);
    expect(jsonValues).toEqual([recordSnapshot]);
  });

  test("rejects document template UUID references", async () => {
    const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const { ctx } = createContext(["document-templates", "get", baseId, "Authors", uuid], {}, [
      jsonResponse(basePage),
      jsonResponse([table]),
      jsonResponse([documentTemplate]),
    ]);

    await expect(gridsCli.run(ctx)).rejects.toThrow("document template references do not accept UUIDs");
  });

  test("creates workflow email templates", async () => {
    const { ctx, calls, lines } = createContext(
      ["email-templates", "create", baseId],
      { name: "Reminder", subject: "Reminder", html: "<p>Hello</p>" },
      [jsonResponse(basePage), jsonResponse(emailTemplate, 201)],
    );

    await gridsCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/email-templates/by-base/${baseId}`,
    ]);
    expect(calls[1]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ name: "Reminder", subject: "Reminder", html: "<p>Hello</p>" });
    expect(lines).toEqual(["Created email template Reminder (mail1A)."]);
  });

  test("rejects email template UUID references", async () => {
    const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const { ctx } = createContext(["email-templates", "get", baseId, uuid], {}, [jsonResponse(basePage), jsonResponse([emailTemplate])]);

    await expect(gridsCli.run(ctx)).rejects.toThrow("email template references do not accept UUIDs");
  });

  test("validates workflow YAML through the backend", async () => {
    const { ctx, calls, lines } = createContext(["workflows", "validate", baseId], { source: workflow.source }, [
      jsonResponse(basePage),
      jsonResponse({ ok: true, plan: workflow.plan }),
    ]);

    const exitCode = await gridsCli.run(ctx);

    expect(exitCode).toBe(0);
    expect(calls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/workflows/by-base/${baseId}/validate`,
    ]);
    expect(calls[1]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ source: workflow.source });
    expect(lines).toEqual(["Workflow YAML is valid."]);
  });

  test("uses -f as workflow YAML file for workflow create", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grids-cli-workflow-"));
    const sourceFile = join(dir, "workflow.yml");
    await writeFile(sourceFile, workflow.source);
    try {
      const { ctx, calls, lines } = createContext(["workflows", "create", baseId], { name: "Send reminder", f: sourceFile }, [
        jsonResponse(basePage),
        jsonResponse(workflow, 201),
      ]);

      await gridsCli.run(ctx);

      expect(calls.map((call) => call.path)).toEqual([
        `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
        `/api/grids/workflows/by-base/${baseId}`,
      ]);
      expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ name: "Send reminder", source: workflow.source });
      expect(lines).toEqual(["Created workflow Send reminder (wf001A)."]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("sends the resolved workflow revision when updating", async () => {
    const updated = { ...workflow, name: "Updated reminder", revision: workflow.revision + 1 };
    const { ctx, calls, lines } = createContext(["workflows", "update", baseId, workflow.id], { name: updated.name }, [
      jsonResponse(basePage),
      jsonResponse([workflow]),
      jsonResponse(updated),
    ]);

    await gridsCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/workflows/by-base/${baseId}`,
      `/api/grids/workflows/${workflowId}`,
    ]);
    expect(new Headers(calls[2]?.init?.headers).get(WORKFLOW_REVISION_HEADER)).toBe(String(workflow.revision));
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ name: updated.name });
    expect(lines).toEqual(["Updated workflow Updated reminder (wf001A)."]);
  });

  test("rejects workflow UUID references", async () => {
    const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const { ctx } = createContext(["workflows", "get", baseId, uuid], {}, [jsonResponse(basePage), jsonResponse([workflow])]);

    await expect(gridsCli.run(ctx)).rejects.toThrow("workflow references do not accept UUIDs");
  });

  test("invokes workflows with JSON inputs", async () => {
    const { ctx, calls, lines } = createContext(
      ["workflows", "invoke", baseId, "Send reminder"],
      { inputs: JSON.stringify({ recordId }), "idempotency-key": "reminder-1" },
      [
        jsonResponse(basePage),
        jsonResponse([workflow]),
        jsonResponse({ runId, workflowId, revision: 1, mode: "execute", channel: "api", created: true, status: "queued" }),
      ],
    );

    await gridsCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/workflows/by-base/${baseId}`,
      `/api/grids/workflows/${workflowId}/invoke/cli`,
    ]);
    expect(calls[2]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ mode: "execute", inputs: { recordId }, idempotencyKey: "reminder-1" });
    expect(lines).toEqual([`Created workflow run ${runId} (queued).`]);
  });

  test("manually invokes scheduled workflows through the same CLI endpoint", async () => {
    const scheduledWorkflow = {
      ...workflow,
      source: 'triggers:\n  schedule:\n    cron: "0 8 * * *"\nsteps:\n  - setVariable:\n      name: ok\n      value: true',
    };
    const { ctx, calls, lines } = createContext(
      ["workflows", "invoke", baseId, "Send reminder"],
      { "idempotency-key": "scheduled-manual-1" },
      [
        jsonResponse(basePage),
        jsonResponse([scheduledWorkflow]),
        jsonResponse({ runId, workflowId, revision: 1, mode: "execute", channel: "api", created: true, status: "queued" }),
      ],
    );

    await gridsCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/workflows/by-base/${baseId}`,
      `/api/grids/workflows/${workflowId}/invoke/cli`,
    ]);
    expect(calls[2]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ mode: "execute", inputs: {}, idempotencyKey: "scheduled-manual-1" });
    expect(lines).toEqual([`Created workflow run ${runId} (queued).`]);
  });

  test("lists workflow run steps", async () => {
    const step = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      runId,
      key: "steps.0",
      sourcePath: ["steps", 0],
      iterationPath: [],
      kind: "action",
      action: "setVariable",
      mode: "execute",
      // A step completes; "succeeded" is the run's word and never appears here.
      status: "completed",
      outcome: { state: "completed", output: { ok: true } },
      executionGeneration: 1,
      startedAt: "2026-07-07T00:00:00.000Z",
      finishedAt: "2026-07-07T00:00:01.000Z",
    };
    const { ctx, calls, tables } = createContext(["workflow-runs", "steps", runId], {}, [jsonResponse({ items: [step] })]);

    await gridsCli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([`/api/grids/workflows/runs/${runId}/steps`]);
    expect(tables[0]).toEqual([
      {
        key: "steps.0",
        path: "steps.0",
        iteration: "",
        kind: "action",
        action: "setVariable",
        status: "completed",
        attempt: 1,
        outcome: '{"state":"completed","output":{"ok":true}}',
      },
    ]);
  });

  test("requires confirmation before deleting workflow email templates", async () => {
    const { ctx } = createContext(["email-templates", "delete", baseId, "Reminder"], {}, []);

    await expect(gridsCli.run(ctx)).rejects.toThrow("Pass --yes to delete.");
  });
});

#!/usr/bin/env bun
import { mkdir, readdir, unlink } from "node:fs/promises";
import { type GotenbergConfig, getGotenbergConfig } from "@k2b/cloud/services";
import { sql } from "bun";
import type { DocumentTemplate } from "../src/contracts";
import { DOCUMENT_TEMPLATE_STARTERS, type DocumentTemplateStarter, documentTemplateStarterById } from "../src/document-template-starters";
import { gridsService } from "../src/service";

type Args = Record<string, string | boolean>;

const parseArgs = (): Args => {
  const args: Args = {};
  for (const item of process.argv.slice(2)) {
    if (!item.startsWith("--")) continue;
    const [key, rawValue] = item.slice(2).split("=", 2);
    args[key] = rawValue ?? true;
  }
  return args;
};

const usage = () => `Usage:
  bun run scripts/render-document-template-previews.ts --base=hNTsc1 --table=d5wcP2 [--record=<public-id>] [--starter=all|invoice] [--template=all] [--out=/tmp/grids-pdf-previews] [--gotenberg-url=http://localhost:3000] [--repeat-rows=80] [--png]
`;

const requirePublicId = (value: string, kind: string): string => {
  if (!/^[A-Za-z0-9]{6}$/.test(value)) throw new Error(`${kind} must be a 6-character public id`);
  return value;
};

const stringArg = (args: Args, key: string): string | undefined => {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const boolArg = (args: Args, key: string): boolean => args[key] === true || args[key] === "true" || args[key] === "1";

const intArg = (args: Args, key: string, fallback: number): number => {
  const value = stringArg(args, key);
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);

const commandExists = async (command: string): Promise<boolean> => {
  const proc = Bun.spawn(["bash", "-lc", `command -v ${command}`], { stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0;
};

const runText = async (cmd: string[]): Promise<string | null> => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return code === 0 ? stdout.trim() : null;
};

const removeExistingPngs = async (outDir: string, name: string): Promise<void> => {
  const entries = await readdir(outDir);
  await Promise.all(
    entries
      .filter((entry) => entry === `${name}.png` || (entry.startsWith(`${name}-`) && entry.endsWith(".png")))
      .map((entry) => unlink(`${outDir}/${entry}`)),
  );
};

const renderedPngs = async (outDir: string, name: string): Promise<string[]> => {
  const entries = await readdir(outDir);
  return entries
    .filter((entry) => entry.startsWith(`${name}-`) && entry.endsWith(".png"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((entry) => `${outDir}/${entry}`);
};

const firstRecordId = async (tableId: string): Promise<string> => {
  const [row] = await sql<{ short_id: string }[]>`
    SELECT short_id
    FROM grids.records
    WHERE table_id = ${tableId}::uuid AND deleted_at IS NULL
    ORDER BY created_at
    LIMIT 1
  `;
  if (!row) throw new Error("No live record found. Pass --record=<public-id> or create a record first.");
  return row.short_id;
};

const loadRenderData = async (params: { template: Pick<DocumentTemplate, "source">; tableId: string; recordId: string }) => {
  const table = await gridsService.table.get(params.tableId);
  if (!table) throw new Error("Table not found");
  const record = await gridsService.record.getByShortId(params.recordId);
  if (!record || record.tableId !== params.tableId) throw new Error("Record not found");
  const live = await gridsService.document.buildLiveRenderData({ template: params.template as DocumentTemplate, table, record });
  if (!live.ok) throw new Error(live.error.message);
  return live.data.data;
};

const withRepeatedRows = (data: Record<string, unknown>, repeatRows: number): Record<string, unknown> => {
  if (repeatRows <= 1 || !Array.isArray(data.rows) || data.rows.length === 0) return data;

  const rows = Array.from({ length: repeatRows }, (_, index) => {
    const source = data.rows[index % data.rows.length];
    return typeof source === "object" && source !== null ? { ...(source as Record<string, unknown>), previewRow: index + 1 } : source;
  });
  const query = typeof data.query === "object" && data.query !== null ? { ...(data.query as Record<string, unknown>), rows } : { rows };
  return { ...data, rows, query };
};

const starterTemplate = (starter: DocumentTemplateStarter, tableId: string): DocumentTemplate =>
  ({
    id: starter.id,
    shortId: "START01",
    tableId,
    name: starter.name,
    description: starter.description,
    source: starter.source(tableId),
    html: starter.html,
    headerHtml: starter.headerHtml ?? null,
    footerHtml: starter.footerHtml ?? null,
    pageCss: starter.pageCss ?? null,
    enabled: true,
    position: 0,
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }) satisfies DocumentTemplate;

const loadTargets = async (params: { tableId: string; starter?: string; template?: string }): Promise<DocumentTemplate[]> => {
  const targets: DocumentTemplate[] = [];
  if (params.starter) {
    const starters = params.starter === "all" ? DOCUMENT_TEMPLATE_STARTERS : [documentTemplateStarterById(params.starter)].filter(Boolean);
    if (starters.length === 0) throw new Error(`Unknown starter: ${params.starter}`);
    targets.push(...starters.map((starter) => starterTemplate(starter, params.tableId)));
  }
  if (params.template) {
    const saved = await gridsService.document.listTemplatesForTable(params.tableId);
    targets.push(
      ...(params.template === "all"
        ? saved
        : saved.filter((template) => template.shortId === params.template || template.name === params.template)),
    );
  }
  if (targets.length === 0) targets.push(...DOCUMENT_TEMPLATE_STARTERS.map((starter) => starterTemplate(starter, params.tableId)));
  return targets;
};

const renderTarget = async (params: {
  target: DocumentTemplate;
  recordId: string;
  outDir: string;
  config: GotenbergConfig;
  png: boolean;
  repeatRows: number;
}): Promise<void> => {
  const data = withRepeatedRows(
    await loadRenderData({ template: params.target, tableId: params.target.tableId, recordId: params.recordId }),
    params.repeatRows,
  );
  const result = await gridsService.document.renderPdfPreview(params.target, data, `${slug(params.target.name)}.html`, params.config);
  if (!result.ok) throw new Error(`${params.target.name}: ${result.error.phase}: ${result.error.message}`);

  const name = slug(params.target.name);
  const pdfPath = `${params.outDir}/${name}.pdf`;
  await Bun.write(pdfPath, result.pdf.pdf);
  const meta: Record<string, unknown> = { name: params.target.name, pdf: pdfPath, bytes: result.pdf.pdf.byteLength };

  if (await commandExists("pdfinfo")) {
    const info = await runText(["pdfinfo", pdfPath]);
    if (info)
      meta.pdfinfo = Object.fromEntries(
        info
          .split("\n")
          .map((line) => line.split(/:\s+/, 2))
          .filter((parts): parts is [string, string] => parts.length === 2),
      );
  }
  if (params.png && (await commandExists("pdftoppm"))) {
    await removeExistingPngs(params.outDir, name);
    await runText(["pdftoppm", "-png", "-r", "144", pdfPath, `${params.outDir}/${name}`]);
    meta.pngs = await renderedPngs(params.outDir, name);
  }
  await Bun.write(`${params.outDir}/${name}.json`, JSON.stringify(meta, null, 2));
  console.log(`${params.target.name}: ${pdfPath}`);
};

const main = async (): Promise<void> => {
  const args = parseArgs();
  const baseRef = stringArg(args, "base");
  const tableRef = stringArg(args, "table");
  if (boolArg(args, "help")) {
    console.log(usage());
    process.exit(0);
  }
  if (!baseRef || !tableRef) {
    console.log(usage());
    process.exit(1);
  }

  const base = await gridsService.base.getByShortId(requirePublicId(baseRef, "Base"));
  if (!base) throw new Error(`Base not found: ${baseRef}`);
  const table = await gridsService.table.getByShortIdForBase(base.id, requirePublicId(tableRef, "Table"));
  if (!table) throw new Error(`Table not found: ${tableRef}`);
  const recordId = requirePublicId(stringArg(args, "record") ?? (await firstRecordId(table.id)), "Record");
  const outDir = stringArg(args, "out") ?? "/tmp/grids-pdf-previews";
  await mkdir(outDir, { recursive: true });

  const config = await getGotenbergConfig();
  const gotenbergUrl = stringArg(args, "gotenberg-url") ?? process.env.GOTENBERG_URL;
  if (gotenbergUrl) config.url = gotenbergUrl;

  const targets = await loadTargets({ tableId: table.id, starter: stringArg(args, "starter"), template: stringArg(args, "template") });
  const repeatRows = intArg(args, "repeat-rows", 1);
  for (const target of targets) await renderTarget({ target, recordId, outDir, config, png: boolArg(args, "png"), repeatRows });
  console.log(`Wrote ${targets.length} preview(s) to ${outDir}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

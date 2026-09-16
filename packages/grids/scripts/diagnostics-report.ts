import { join } from "node:path";

export type DiagnosticSample = {
  scenario: string;
  rows?: number;
  warmup?: boolean;
  totalMs: number;
  timings: Record<string, number>;
  resultRows?: number;
};
export type DiagnosticReport = {
  environment: Record<string, unknown>;
  samples: DiagnosticSample[];
  status: "running" | "complete" | "failed";
  error?: string;
  measuredMs?: number;
};

export const summarize = (values: number[]) => {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("Invalid timing samples");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return { median: (sorted[mid]! + sorted[Math.floor((sorted.length - 1) / 2)]!) / 2, min: sorted[0]!, max: sorted.at(-1)! };
};
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export const writeDiagnosticReport = async (directory: string, report: DiagnosticReport) => {
  await Bun.write(join(directory, "results.json"), JSON.stringify(report, null, 2));
  const groups = new Map<string, DiagnosticSample[]>();
  for (const sample of report.samples.filter((entry) => !entry.warmup)) {
    const key = `${sample.scenario}${sample.rows ? ` · ${sample.rows} Datensätze` : ""}`;
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  const rows = [...groups].map(([name, samples]) => ({ name, n: samples.length, ...summarize(samples.map((sample) => sample.totalMs)) }));
  const round = (value: number) => value.toFixed(1);
  const table = rows.map((row) => `| ${row.name} | ${row.n} | ${round(row.median)} | ${round(row.min)}–${round(row.max)} |`).join("\n");
  const note =
    "Lokale Diagnose, keine Kapazitätsmessung. Serielle Aufrufe, fünf Stichproben; PDF und Überlappung sind Einzelmessungen. Backend inklusive Berechtigungen und Admission, ohne Browser/Gateway und persistierte GQL-Traces. Aufwärmläufe stehen nur in results.json. Gotenberg wird wiederverwendet: erster PDF-Lauf bedeutet nicht kalt gestarteter Renderer. PDF-HTTP misst bis zu den Antwort-Headern; übrige Dokumentarbeit wird nicht als reine Speicherzeit ausgegeben.";
  await Bun.write(
    join(directory, "summary.md"),
    `# Grids Performance-Diagnose\n\nStatus: ${report.status}\n\n${note}\n\n| Ablauf | n | Median ms | Min–Max ms |\n|---|---:|---:|---:|\n${table}\n\nRohwerte und Zeitanteile: results.json.\n${report.error ? `\nFehler: ${report.error}\n` : ""}`,
  );
  const gql = rows.filter((row) => row.name.startsWith("GQL"));
  const scale = Math.max(1, ...gql.map((row) => row.median));
  const bars = gql
    .map(
      (row) =>
        `<div class="bar-row"><span>${escape(row.name)}</span><div class="track"><div class="bar" style="width:${(100 * row.median) / scale}%"></div></div><b>${round(row.median)} ms</b></div>`,
    )
    .join("");
  const workflow = report.samples.filter((sample) => sample.timings.queueMs !== undefined);
  const workflowScale = Math.max(1, ...workflow.map((sample) => sample.totalMs));
  const workflowBars = workflow
    .map(
      (sample) =>
        `<div class="bar-row"><span>${escape(sample.scenario)}</span><div class="track stack"><div class="queue" style="width:${(100 * sample.timings.queueMs!) / workflowScale}%"></div><div class="bar" style="width:${(100 * sample.timings.executionMs!) / workflowScale}%"></div></div><b>${round(sample.totalMs)} ms</b></div>`,
    )
    .join("");
  await Bun.write(
    join(directory, "report.html"),
    `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Grids Performance-Diagnose</title><style>body{font:16px/1.5 system-ui;margin:40px auto;padding:0 20px;max-width:1000px;color:#172b32;background:#f5f7f8}h1{line-height:1.15}section{background:white;border:1px solid #d7e0e3;border-radius:12px;padding:24px;margin:20px 0}p{max-width:85ch}.bar-row{display:grid;grid-template-columns:minmax(190px,1fr) 2fr 100px;align-items:center;gap:12px;margin:14px 0}.track{height:20px;background:#edf1f2;border-radius:4px;overflow:hidden}.bar{height:100%;background:#008f6a}.queue{height:100%;background:#e0a629}.stack{display:flex}table{border-collapse:collapse;width:100%}td,th{text-align:left;border-bottom:1px solid #ddd;padding:9px}b{font-variant-numeric:tabular-nums}a{color:#006850}@media(max-width:650px){.bar-row{grid-template-columns:1fr 90px}.bar-row>span{grid-column:1/-1}body{margin:20px auto}section{padding:14px}}</style><h1>Grids: Wo bleibt die Zeit?</h1><p>Status: <strong>${escape(report.status)}</strong> · <a href="results.json">Rohwerte</a> · <a href="summary.md">Zusammenfassung</a></p><p>${escape(note)}</p><section><h2>GQL · Median</h2>${bars}</section><section><h2>Workflows · einzelne Durchläufe</h2><p>🟨 Warten bis zum Start · 🟩 Ausführung. Annahmezeit steht separat in den Rohwerten und kann die Wartezeit überlappen.</p>${workflowBars}</section><section><h2>Alle Messungen</h2><table><thead><tr><th>Ablauf</th><th>n</th><th>Median ms</th><th>Min–Max ms</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escape(row.name)}</td><td>${row.n}</td><td>${round(row.median)}</td><td>${round(row.min)}–${round(row.max)}</td></tr>`).join("")}</tbody></table></section>${report.error ? `<p>${escape(report.error)}</p>` : ""}</html>`,
  );
};

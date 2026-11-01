import { open } from "node:fs/promises";
import { arg, command, confirmFlag, flag, localizeCloudCliText, printStructured } from "@k2b/cloud/cli";
import { CODE_AUTHORING_REQUEST_BYTES, type CodeAuthoringData, CodeWorkspaceStatusSchema } from "../code/authoring-contracts";
import { codePolicyPreset } from "../code/policy-contracts";
import { codeRunMessages } from "../code/run-messages";
import { listCodeProjects, loadCodeProject, readCodeFiles } from "./code-files";
import { request } from "./code-request";

/** Read a bounded private file or stdin stream without putting its contents in arguments or error text. */
export async function readCodeInput(from: string): Promise<string> {
  if (from === "-") {
    if (process.stdin.isTTY) throw new Error("Pipe input or supply a file.");
    const reader = Bun.stdin.stream().getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > CODE_AUTHORING_REQUEST_BYTES) throw new Error("Input exceeds the Code request budget.");
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }
  const file = await open(from, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > CODE_AUTHORING_REQUEST_BYTES) throw new Error("Use a regular file within the Code request budget.");
    const bytes = Buffer.alloc(CODE_AUTHORING_REQUEST_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const chunk = await file.read(bytes, size, bytes.length - size, null);
      if (!chunk.bytesRead) break;
      size += chunk.bytesRead;
    }
    if (size > CODE_AUTHORING_REQUEST_BYTES) throw new Error("Input exceeds the Code request budget.");
    return bytes.subarray(0, size).toString("utf8");
  } finally {
    await file.close();
  }
}
export function codeOperationCommands(locale?: string) {
  const t = (en: string, de: string) => localizeCloudCliText(locale, { en, de });
  const projectArg = { project: arg.optional({ description: t("Local project", "Lokales Projekt") }) };
  const revision = flag.int({
    required: true,
    min: 1,
    description: t("Revision read before editing", "Vor dem Bearbeiten gelesene Revision"),
  });
  const from = flag.string({ required: true, description: t("Input file or - for stdin", "Eingabedatei oder - für stdin") });
  const cursor = flag.string({ description: t("Opaque nextCursor from previous page", "nextCursor aus der vorherigen Seite") });
  const limit = flag.int({ min: 1, max: 50, default: 20, description: t("Page size (1–50)", "Seitengröße (1–50)") });
  const policyFlags = {
    revision,
    from: flag.string({ description: t("Complete policy definition file or -", "Vollständige Richtlinien-Datei oder -") }),
    preset: flag.enum(["off", "admin", "open"], {
      description: t("Replace the complete table with a preset", "Vollständige Tabelle durch Vorlage ersetzen"),
    }),
  };
  async function definition(flags: { from?: string; preset?: "off" | "admin" | "open" }) {
    if (Boolean(flags.from) === Boolean(flags.preset))
      throw new Error(t("Supply exactly one of --from or --preset.", "Gib genau --from oder --preset an."));
    return flags.preset ? codePolicyPreset(flags.preset) : JSON.parse(await readCodeInput(flags.from!));
  }
  return [
    command("status", {
      summary: t(
        "Compare all local Code with server versions, approval and execution",
        "Alle lokalen Codes mit Versionen, Freigabe und Ausführung auf dem Server vergleichen",
      ),
      args: {
        root: arg.optional({
          description: t("Checkout root or one project (default: .)", "Checkout-Wurzel oder einzelnes Projekt (Standard: .)"),
        }),
      },
      async run({ ctx, args }) {
        const items: CodeAuthoringData<"status">["items"] = [];
        for (const project of await listCodeProjects(args.root)) {
          const data = await request(ctx, "status", { config: project.config, files: await readCodeFiles(project.directory) });
          items.push(...data.items);
        }
        const data = CodeWorkspaceStatusSchema.parse({ version: 1, items });
        if (!printStructured(ctx, data)) {
          if (!items.length) ctx.print(t("No local Code projects.", "Keine lokalen Code-Projekte."));
          for (const item of items) {
            ctx.print(
              `${item.code.id} · ${t("base", "Basis")} ${item.baseVersionId ?? "—"} · ${t("latest", "aktuell")} ${item.latest?.version.id ?? "—"} · ${t("approval", "Freigabe")} ${item.latest?.status ?? "—"} · ${t("active", "aktiv")} ${item.code.activeVersionId ?? "—"} · ${item.code.state}${item.code.pauseReason ? ` (${item.code.pauseReason})` : ""} · ${item.modified ? t("local edits", "lokal geändert") : t("unchanged", "unverändert")}${item.baseCurrent ? "" : t(" · newer server base", " · neuerer Serverstand")}`,
            );
          }
        }
      },
    }),
    command("runs", {
      summary: t("List runs or read a run and its ordered call page", "Läufe auflisten oder Lauf mit geordneter Aufrufseite lesen"),
      args: projectArg,
      flags: {
        run: flag.string({ description: t("Run UUID", "Lauf-UUID") }),
        cursor,
        limit,
        callCursor: flag.int({
          min: 0,
          description: t("Last call ordinal; 0 starts the call list", "Letzte Aufrufnummer; 0 beginnt die Liste"),
        }),
        content: flag.enum(["input", "output", "call", "result"], {
          description: t("Read a large payload as a text chunk", "Große Nutzdaten als Textabschnitt lesen"),
        }),
        ordinal: flag.int({ min: 1, description: t("Call ordinal for call/result content", "Aufrufnummer für call/result-Inhalt") }),
        offset: flag.int({ min: 0, description: t("UTF-16 content offset", "UTF-16-Inhaltsversatz") }),
      },
      async run({ ctx, args, flags }) {
        const { config } = await loadCodeProject(args.project);
        const messages = codeRunMessages.resolve(locale ? [locale] : []).t;
        const outcome = (value: string | null) =>
          value === "previous_schedule_running" ? messages.previousScheduleRunning : value === "lease_lost" ? messages.lost : (value ?? "");
        if (flags.run) {
          if (flags.cursor) throw new Error(t("Use --call-cursor for a run's calls.", "Nutze --call-cursor für die Aufrufe eines Laufs."));
          if ((flags.content === "call" || flags.content === "result") && !flags.ordinal)
            throw new Error("--ordinal is required for call/result.");
          const content = !flags.content
            ? undefined
            : flags.content === "call" || flags.content === "result"
              ? { kind: flags.content, ordinal: flags.ordinal }
              : { kind: flags.content };
          const data = await request(ctx, "runRead", {
            codeId: config.codeId,
            runId: flags.run,
            cursor: flags.callCursor,
            content,
            offset: flags.offset,
          });
          if (!printStructured(ctx, data)) {
            ctx.print(`${data.run.id} · ${data.run.state} · ${outcome(data.run.outcome)}`);
            if (!data.contents) ctx.print(t("Run contents require editor access.", "Laufinhalte erfordern Bearbeitungsrechte."));
            else {
              for (const call of data.contents.calls) ctx.print(`${call.ordinal} · ${call.capability} · ${call.state}`);
              ctx.print(JSON.stringify(data.contents, null, 2));
              if (data.contents.nextCursor !== null) ctx.print(`--call-cursor ${data.contents.nextCursor}`);
            }
          }
        } else {
          if (flags.callCursor !== undefined || flags.content || flags.ordinal || flags.offset !== undefined)
            throw new Error("Call/content flags require --run.");
          const data = await request(ctx, "runs", { codeId: config.codeId, cursor: flags.cursor, limit: flags.limit });
          if (!printStructured(ctx, data)) {
            if (!data.items.length) ctx.print(t("No runs.", "Keine Läufe."));
            for (const run of data.items) ctx.print(`${run.id} · ${run.entrypoint} · ${run.state} · ${outcome(run.outcome)}`);
            if (data.nextCursor) ctx.print(`--cursor ${data.nextCursor}`);
          }
        }
      },
    }),
    ...(["pause", "resume"] as const).map((name) =>
      command(name, {
        summary:
          name === "pause"
            ? t("Pause new runs", "Neue Läufe pausieren")
            : t("Resume the active approved version", "Aktive freigegebene Version fortsetzen"),
        args: projectArg,
        flags: { yes: confirmFlag() },
        async run({ ctx, args, flags }) {
          if (name === "resume" && ctx.options.ci)
            throw new Error(t("CI may push Code but cannot resume it.", "CI darf Code pushen, aber nie fortsetzen."));
          if (!flags.yes) throw new Error("--yes is required.");
          const { config } = await loadCodeProject(args.project);
          const data = await request(ctx, name, { codeId: config.codeId });
          if (!printStructured(ctx, data)) ctx.print(`${config.codeId} · ${data.state}`);
        },
      }),
    ),
    command("policy read", {
      summary: t("Read the current policy and revision", "Aktuelle Richtlinie und Revision lesen"),
      async run({ ctx }) {
        const data = await request(ctx, "policyRead", {});
        if (!printStructured(ctx, data)) ctx.print(JSON.stringify(data.policy, null, 2));
      },
    }),
    command("policy effective", {
      summary: t("Resolve effective policy for an owner", "Wirksame Richtlinie für einen Besitzer auflösen"),
      flags: {
        owner: flag.string({
          description: t("Owner JSON file (optional; defaults to self)", "Besitzer-JSON-Datei (optional; Standard ist eigene Person)"),
        }),
        authorId: flag.string({ description: t("Version author UUID (admin only)", "Versionsautor-UUID (nur Admin)") }),
      },
      async run({ ctx, flags }) {
        const data = await request(ctx, "policyEffective", {
          owner: flags.owner ? JSON.parse(await readCodeInput(flags.owner)) : undefined,
          authorId: flags.authorId,
        });
        if (!printStructured(ctx, data)) {
          ctx.print(`${t("Revision", "Revision")} ${data.revision}`);
          for (const row of data.rows) ctx.print(`${row.row} · ${row.value} · ${row.source}`);
        }
      },
    }),
    command("policy preview", {
      summary: t("Preview affected Code against a read revision", "Betroffene Codes gegen eine gelesene Revision prüfen"),
      flags: { ...policyFlags, cursor, limit },
      async run({ ctx, flags }) {
        const data = await request(ctx, "policyPreview", {
          revision: flags.revision,
          definition: await definition(flags),
          cursor: flags.cursor,
          limit: flags.limit,
        });
        if (!printStructured(ctx, data)) {
          ctx.print(`${t("Affected", "Betroffen")}: ${data.total} · Revision ${data.revision}`);
          for (const item of data.items) ctx.print(`${item.codeId} · ${item.title} · ${item.rows.join(", ")}`);
          if (data.nextCursor) ctx.print(`--cursor ${data.nextCursor}`);
        }
      },
    }),
    command("policy update", {
      summary: t("Replace policy at the reviewed revision", "Richtlinie mit geprüfter Revision ersetzen"),
      flags: { ...policyFlags, yes: confirmFlag() },
      async run({ ctx, flags }) {
        if (!flags.yes) throw new Error("--yes is required.");
        const data = await request(ctx, "policyUpdate", { revision: flags.revision, definition: await definition(flags) });
        if (!printStructured(ctx, data))
          ctx.print(`Revision ${data.policy.revision} · ${data.policy.definition.preset} · ${data.pauseJobId}`);
      },
    }),
    command("secret set", {
      summary: t("Write a secret from stdin or file; never from an argument", "Secret aus stdin oder Datei speichern; nie als Argument"),
      args: { name: arg.required({ description: "Secret name" }), ...projectArg },
      flags: {
        from,
        binding: flag.string({
          description: t("Destination binding JSON file; required for a new name", "Zielbindungs-JSON-Datei; für neue Namen erforderlich"),
        }),
        bindingRevision: flag.string({
          required: true,
          description: t("Current UUID, or null for a new name", "Aktuelle UUID oder null für neuen Namen"),
        }),
      },
      async run({ ctx, args, flags }) {
        const { config } = await loadCodeProject(args.project);
        const binding = flags.binding ? JSON.parse(await readCodeInput(flags.binding)) : undefined;
        // Strip one line ending added by terminal tools; no trimming of credential bytes.
        const value = (await readCodeInput(flags.from!)).replace(/\r?\n$/, "");
        const data = await request(ctx, "secretSet", {
          codeId: config.codeId,
          name: args.name,
          value,
          binding,
          binding_revision: flags.bindingRevision === "null" ? null : flags.bindingRevision,
        });
        if (!printStructured(ctx, data)) ctx.print(`${data.secret.name} · ${data.secret.binding_revision} · ${t("configured", "gesetzt")}`);
      },
    }),
    command("secret list", {
      summary: t("List secret names, bindings and revisions (no values)", "Secret-Namen, Bindungen und Revisionen auflisten (keine Werte)"),
      args: projectArg,
      flags: { cursor, limit: flag.int({ min: 1, max: 20, default: 20, description: "Page size (1–20)" }) },
      async run({ ctx, args, flags }) {
        const { config } = await loadCodeProject(args.project);
        const data = await request(ctx, "secretList", { codeId: config.codeId, cursor: flags.cursor, limit: flags.limit });
        if (!printStructured(ctx, data)) {
          if (!data.items.length) ctx.print(t("No secrets.", "Keine Secrets."));
          for (const secret of data.items)
            ctx.print(
              `${secret.name} · ${secret.binding_revision} · ${secret.configured ? t("configured", "gesetzt") : t("deleted", "gelöscht")} · ${secret.origin}${secret.pathPrefix} · ${secret.headers.join(", ")}`,
            );
          if (data.nextCursor) ctx.print(`--cursor ${data.nextCursor}`);
        }
      },
    }),
    command("secret delete", {
      summary: t(
        "Delete the value for every version; retain binding evidence",
        "Wert für alle Versionen löschen; Bindungsnachweis behalten",
      ),
      args: { name: arg.required({ description: "Secret name" }), ...projectArg },
      flags: { bindingRevision: flag.string({ required: true, description: "Current binding UUID" }), yes: confirmFlag() },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("--yes is required.");
        const { config } = await loadCodeProject(args.project);
        const data = await request(ctx, "secretDelete", {
          codeId: config.codeId,
          name: args.name,
          binding_revision: flags.bindingRevision,
        });
        if (!printStructured(ctx, data)) ctx.print(t("Secret value deleted.", "Secret-Wert gelöscht."));
      },
    }),
  ];
}

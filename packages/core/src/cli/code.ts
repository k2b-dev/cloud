import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  arg,
  type CloudCliContext,
  command,
  confirmFlag,
  defineCliCommands,
  flag,
  localizeCloudCliText,
  printStructured,
} from "@k2b/cloud/cli";
import { CodeTestCaseSchema } from "@k2b/cloud/code";
import { z } from "zod";
import {
  CODE_AUTHORING_REQUEST_BYTES,
  type CodeAuthoringCommand,
  CodeAuthoringConflictSchema,
  type CodeAuthoringData,
  type CodeAuthoringError,
  CodeAuthoringErrorSchema,
  codeAuthoringContracts,
} from "../code/authoring-contracts";
import { CodeIdSchema } from "../code/contracts";
import type { CodeVersionDiffFile } from "../code/version-contracts";
import {
  assertCodeDestination,
  assertCodePath,
  loadCodeProject,
  readCodeFiles,
  saveCodeProject,
  writeCodeProject,
  writeCodeSdk,
} from "./code-files";

class RemoteCodeError extends Error {
  constructor(readonly body: CodeAuthoringError) {
    super(body.error.message);
  }
}
function request(ctx: CloudCliContext, name: "init", input: unknown): Promise<CodeAuthoringData<"init">>;
function request(ctx: CloudCliContext, name: "pull", input: unknown): Promise<CodeAuthoringData<"pull">>;
function request(ctx: CloudCliContext, name: "sdk", input: unknown): Promise<CodeAuthoringData<"sdk">>;
function request(ctx: CloudCliContext, name: "check", input: unknown): Promise<CodeAuthoringData<"check">>;
function request(ctx: CloudCliContext, name: "test", input: unknown): Promise<CodeAuthoringData<"test">>;
function request(ctx: CloudCliContext, name: "simulate", input: unknown): Promise<CodeAuthoringData<"simulate">>;
function request(ctx: CloudCliContext, name: "push", input: unknown): Promise<CodeAuthoringData<"push">>;
function request(ctx: CloudCliContext, name: "submit", input: unknown): Promise<CodeAuthoringData<"submit">>;
function request(ctx: CloudCliContext, name: "diff", input: unknown): Promise<CodeAuthoringData<"diff">>;
function request(ctx: CloudCliContext, name: "activate", input: unknown): Promise<CodeAuthoringData<"activate">>;
function request(ctx: CloudCliContext, name: "run", input: unknown): Promise<CodeAuthoringData<"run">>;
function request(ctx: CloudCliContext, name: "push" | "submit", input: unknown): Promise<CodeAuthoringData<"push">>;
async function request(ctx: CloudCliContext, name: CodeAuthoringCommand, input: unknown) {
  const body = JSON.stringify(codeAuthoringContracts[name].input.parse(input));
  if (Buffer.byteLength(body) > CODE_AUTHORING_REQUEST_BYTES) throw new Error("Code command exceeds the checker request budget.");
  const response = await ctx.fetch(`/api/code/authoring/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const failure = CodeAuthoringErrorSchema.safeParse(parsed);
    if (failure.success) throw new RemoteCodeError(failure.data);
    throw new RemoteCodeError({
      version: 1,
      error: {
        code: `http_${response.status}`,
        message: `Code request failed (${response.status}). Read the current state before retrying a write.`,
        details: null,
      },
    });
  }
  return codeAuthoringContracts[name].data.parse(await response.json());
}
function printDiff(ctx: CloudCliContext, files: CodeVersionDiffFile[]) {
  for (const file of files) {
    ctx.print(`--- ${file.path}`);
    for (const line of file.lines) ctx.print(`${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`);
  }
}
/** Chapter 11 permission list: operation, live target title/ID, one-based source location and newly needed administrator. */
export function printCodeCheck(ctx: CloudCliContext, data: CodeAuthoringData<"check">) {
  const t = (en: string, de: string) => localizeCloudCliText(ctx.options.locale, { en, de });
  if (!data.result.ok) {
    for (const diagnostic of data.result.diagnostics)
      ctx.print(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.code}: ${diagnostic.message}`);
    return;
  }
  ctx.print(t("Permissions", "Erlaubnisse"));
  for (const permission of data.permissions) {
    const type = permission.typeTitle ?? permission.target?.type ?? t("application", "App");
    const target = permission.target
      ? `${type} ${permission.title ? `${permission.title} ` : ""}${permission.target.id === null ? t("(dynamic target)", "(dynamisches Ziel)") : `(${permission.target.id})`}`.trim()
      : t("application", "App");
    const place = permission.own ? t(`at own ${target}`, `am eigenen ${target}`) : t(`at ${target}`, `an ${target}`);
    const newly = permission.needsTargetAdmin ? t(`  ← new, needs the admin of ${type}`, `  ← neu, braucht den Admin des ${type}`) : "";
    ctx.print(`  ${permission.operation.padEnd(27)} ${place}   ${permission.file}:${permission.line}${newly}`);
  }
  ctx.print(`${t("AI", "KI").padEnd(13)}${data.result.manifest.ai ? t("yes", "ja") : t("no", "nein")}`);
  ctx.print(`${t("Pages", "Seiten").padEnd(13)}—`);
  ctx.print("Webhook      —");
  ctx.print(`${t("Database", "Datenbank").padEnd(13)}—`);
}
export function buildCodeCli(locale?: string) {
  const t = (en: string, de: string) => localizeCloudCliText(locale, { en, de });
  const projectArg = {
    project: arg.optional({
      description: t("Local project directory or a file inside it", "Lokales Projektverzeichnis oder eine Datei darin"),
    }),
  };
  const outFlag = { out: flag.string({ default: "code", description: t("New checkout root", "Neues Zielverzeichnis") }) };
  return defineCliCommands({
    name: "code",
    summary: t("Develop, check and submit Code", "Code entwickeln, prüfen und einreichen"),
    requiresCloud: true,
    groupSummaries: { sdk: t("Download the generated SDK", "Erzeugtes SDK herunterladen") },
    commands: [
      command("init", {
        summary: t("Create Code and a local project", "Code und lokales Projekt anlegen"),
        flags: {
          ...outFlag,
          title: flag.string({ required: true, description: t("Code title", "Code-Titel") }),
          ownerType: flag.string({ description: t("Owning resource Type", "Typ der Besitzer-Ressource") }),
          ownerId: flag.string({ description: t("Short resource ID", "Kurze Ressourcen-ID") }),
          app: flag.string({ description: t("Owning application ID", "ID der Besitzer-App") }),
        },
        async run({ ctx, flags }) {
          if (Boolean(flags.ownerType) !== Boolean(flags.ownerId) || (flags.app && flags.ownerType))
            throw new Error(
              t("Supply --owner-type and --owner-id together, or --app.", "Gib --owner-type und --owner-id zusammen oder --app an."),
            );
          const owner = flags.app
            ? { kind: "app", appId: flags.app }
            : flags.ownerType
              ? { kind: "resource", ref: { type: flags.ownerType, id: flags.ownerId } }
              : undefined;
          const input = codeAuthoringContracts.init.input.parse({ title: flags.title, ...(owner ? { owner } : {}) });
          await assertCodeDestination(flags.out!, input.owner);
          const data = await request(ctx, "init", input);
          try {
            await writeCodeProject(flags.out!, data.config, data.files);
          } catch {
            throw new RemoteCodeError({
              version: 1,
              error: {
                code: "code_cli_checkout_failed",
                message: t(
                  `Created ${data.config.codeId}, but the local project could not be written. Pull this Code ID into a new directory.`,
                  `${data.config.codeId} angelegt, aber lokal konnte das Projekt nicht geschrieben werden. Hole diese Code-ID mit pull in ein neues Verzeichnis.`,
                ),
                details: z.json().parse({ config: data.config }),
              },
            });
          }
          if (!printStructured(ctx, data))
            ctx.print(
              t(
                `Created ${data.config.codeId}. Run sdk pull in its directory.`,
                `${data.config.codeId} angelegt. Führe dort sdk pull aus.`,
              ),
            );
        },
      }),
      command("pull", {
        summary: t("Download the latest version into a new folder", "Neueste Version in einen neuen Ordner holen"),
        args: { code: arg.required({ description: "Code ID" }) },
        flags: outFlag,
        async run({ ctx, args, flags }) {
          const codeId = CodeIdSchema.parse(args.code);
          await assertCodePath(resolve(flags.out!));
          const data = await request(ctx, "pull", { codeId });
          await writeCodeProject(flags.out!, data.config, data.files);
          if (!printStructured(ctx, data))
            ctx.print(
              t(
                `Pulled ${codeId} at ${data.config.baseVersionId ?? "empty"}.`,
                `${codeId} auf Stand ${data.config.baseVersionId ?? "leer"} geholt.`,
              ),
            );
        },
      }),
      command("sdk pull", {
        summary: t("Refresh project SDK types and runtime", "SDK-Typen und Laufzeit aktualisieren"),
        args: projectArg,
        async run({ ctx, args }) {
          const project = await loadCodeProject(args.project);
          const data = await request(ctx, "sdk", { codeId: project.config.codeId });
          await writeCodeSdk(project.directory, data.files);
          if (!printStructured(ctx, data)) ctx.print(t("SDK refreshed.", "SDK aktualisiert."));
        },
      }),
      command("check", {
        summary: t("Check types and show every permission", "Typen prüfen und alle Erlaubnisse anzeigen"),
        args: projectArg,
        async run({ ctx, args }) {
          const project = await loadCodeProject(args.project);
          const data = await request(ctx, "check", {
            codeId: project.config.codeId,
            entry: project.config.entry,
            files: await readCodeFiles(project.directory),
          });
          if (!printStructured(ctx, data)) printCodeCheck(ctx, data);
          return data.result.ok ? 0 : 1;
        },
      }),
      command("test", {
        summary: t("Run declarative test/*.json against fakes", "Deklarative test/*.json mit Testdaten ausführen"),
        args: projectArg,
        flags: { trace: flag.boolean({ description: t("Include run boundaries", "Laufgrenzen ausgeben") }) },
        async run({ ctx, args, flags }) {
          const project = await loadCodeProject(args.project);
          const data = await request(ctx, "test", {
            codeId: project.config.codeId,
            entry: project.config.entry,
            files: await readCodeFiles(project.directory),
            tests: await readCodeFiles(project.directory, true),
            trace: flags.trace,
          });
          if (!printStructured(ctx, data)) {
            for (const item of data.cases) ctx.print(`${item.ok ? "✓" : "✗"} ${item.file ?? item.name}`);
            if (data.error) ctx.print(data.error);
            for (const diagnostic of data.diagnostics) ctx.print(`${diagnostic.file}:${diagnostic.line} ${diagnostic.message}`);
          }
          return data.ok ? 0 : 1;
        },
      }),
      command("simulate", {
        summary: t("Simulate one schedule with a JSON fixture", "Einen Zeitplan mit einer JSON-Fixture simulieren"),
        args: projectArg,
        flags: {
          fixture: flag.string({ required: true, description: t("Fixture file relative to project", "Fixture-Datei relativ zum Projekt") }),
          trace: flag.boolean({ description: t("Include run boundaries", "Laufgrenzen ausgeben") }),
        },
        async run({ ctx, args, flags }) {
          const project = await loadCodeProject(args.project);
          const fixturePath = resolve(project.directory, flags.fixture!);
          await assertCodePath(fixturePath);
          const fixture = CodeTestCaseSchema.parse(JSON.parse(await readFile(fixturePath, "utf8")));
          const data = await request(ctx, "simulate", {
            codeId: project.config.codeId,
            entry: project.config.entry,
            files: await readCodeFiles(project.directory),
            fixture,
            trace: flags.trace,
          });
          if (!printStructured(ctx, data)) {
            ctx.print(
              data.ok
                ? t("Simulation passed.", "Simulation erfolgreich.")
                : (data.error ?? t("Simulation failed.", "Simulation fehlgeschlagen.")),
            );
            for (const item of data.cases)
              for (const run of item.runs)
                ctx.print(
                  JSON.stringify({ entrypoint: run.entrypoint, ok: run.ok, value: run.value, calls: run.calls, failures: run.failures }),
                );
          }
          return data.ok ? 0 : 1;
        },
      }),
      ...(["push", "submit"] as const).map((name) =>
        command(name, {
          summary:
            name === "push"
              ? t("Save and submit checked source against its base", "Geprüften Code gegen seinen Basisstand speichern und einreichen")
              : t("Check and submit a version for required approval", "Version prüfen und zur nötigen Freigabe einreichen"),
          args: projectArg,
          flags: {
            baseVersionId: flag.string({
              description: t("Explicit base UUID, or null for first push", "Basis-UUID oder null für den ersten Push"),
            }),
          },
          async run({ ctx, args, flags }) {
            const project = await loadCodeProject(args.project);
            const baseVersionId =
              flags.baseVersionId === undefined
                ? project.config.baseVersionId
                : flags.baseVersionId === "null"
                  ? null
                  : z.uuid().parse(flags.baseVersionId);
            const data = await request(ctx, name, {
              codeId: project.config.codeId,
              entry: project.config.entry,
              files: await readCodeFiles(project.directory),
              baseVersionId,
            });
            try {
              await saveCodeProject(project.directory, { ...project.config, baseVersionId: data.submission.version.id });
            } catch {
              throw new RemoteCodeError({
                version: 1,
                error: {
                  code: "code_cli_local_update_failed",
                  message: t(
                    "Version saved, but local code.json could not be updated. Pull into a fresh directory before retrying.",
                    "Version gespeichert, aber code.json konnte lokal nicht aktualisiert werden. Hole den Stand vor einem neuen Versuch in ein neues Verzeichnis.",
                  ),
                  details: z.json().parse({ submission: data.submission }),
                },
              });
            }
            if (!printStructured(ctx, data)) ctx.print(`${data.submission.version.id} · ${data.submission.status}`);
          },
        }),
      ),
      command("diff", {
        summary: t("Show a saved version's complete comparison", "Vollständigen Unterschied einer gespeicherten Version zeigen"),
        args: projectArg,
        flags: {
          version: flag.string({
            description: t("Version UUID; defaults to code.json base", "Versions-UUID; Standard ist der Basisstand aus code.json"),
          }),
        },
        async run({ ctx, args, flags }) {
          const project = await loadCodeProject(args.project);
          const versionId = flags.version ?? project.config.baseVersionId;
          if (!versionId) throw new Error(t("No saved version. Push first.", "Keine gespeicherte Version. Führe zuerst push aus."));
          const data = await request(ctx, "diff", { codeId: project.config.codeId, versionId });
          if (!printStructured(ctx, data)) printDiff(ctx, data.diff.files);
        },
      }),
      command("activate", {
        summary: t("Activate an approved saved version", "Freigegebene gespeicherte Version einschalten"),
        args: projectArg,
        flags: {
          yes: confirmFlag(),
          version: flag.string({
            description: t("Version UUID; defaults to code.json base", "Versions-UUID; Standard ist der Basisstand aus code.json"),
          }),
          activationId: flag.string({
            required: true,
            description: t("Activation UUID; reuse after a lost response", "Aktivierungs-UUID; nach verlorener Antwort erneut nutzen"),
          }),
        },
        async run({ ctx, args, flags }) {
          if (ctx.options.ci) throw new Error(t("CI may push Code but cannot activate it.", "CI darf Code pushen, aber nie einschalten."));
          if (!flags.yes) throw new Error(t("Activation requires --yes.", "Einschalten erfordert --yes."));
          const project = await loadCodeProject(args.project);
          const versionId = flags.version ?? project.config.baseVersionId;
          if (!versionId) throw new Error(t("No saved version. Push first.", "Keine gespeicherte Version. Führe zuerst push aus."));
          const data = await request(ctx, "activate", {
            codeId: project.config.codeId,
            versionId,
            activationId: flags.activationId,
          });
          if (!printStructured(ctx, data)) ctx.print(`${data.activation.id} · ${data.activation.state}`);
          return ["failed", "cancelled"].includes(data.activation.state) ? 1 : 0;
        },
      }),
      command("run", {
        summary: t("Start a named schedule now", "Benannten Zeitplan jetzt starten"),
        args: { schedule: arg.required({ description: t("Named schedule export", "Benannter Zeitplan-Export") }), ...projectArg },
        flags: {
          key: flag.string({
            required: true,
            description: t("Idempotency key; reuse only to retry this start", "Idempotenzschlüssel; nur für denselben Start erneut nutzen"),
          }),
        },
        async run({ ctx, args, flags }) {
          const project = await loadCodeProject(args.project);
          const data = await request(ctx, "run", {
            codeId: project.config.codeId,
            entrypoint: args.schedule,
            input: null,
            idempotencyKey: flags.key,
          });
          if (!printStructured(ctx, data))
            ctx.print(`${data.run.runId}${data.run.duplicate ? t(" (already started)", " (bereits gestartet)") : ""}`);
        },
      }),
    ],
  });
}
const base = buildCodeCli();
export default {
  ...base,
  help: (locale?: string) => buildCodeCli(locale).help?.(locale) ?? "",
  async run(ctx: CloudCliContext) {
    try {
      return await buildCodeCli(ctx.options.locale).run(ctx);
    } catch (error) {
      const body: CodeAuthoringError =
        error instanceof RemoteCodeError
          ? error.body
          : {
              version: 1,
              error: {
                code: "code_cli_input",
                message:
                  error instanceof Error && "code" in error && typeof error.code === "string"
                    ? `Local Code files could not be read or written (${error.code}). Existing project folders are not overwritten.`
                    : error instanceof Error
                      ? error.message
                      : "Code command failed.",
                details: null,
              },
            };
      if (!printStructured(ctx, body)) {
        ctx.error(
          body.error.code === "code_version_conflict"
            ? localizeCloudCliText(ctx.options.locale, {
                en: "A newer version exists. Review the diff and pull into a new directory before pushing again.",
                de: "Neuere Version vorhanden. Prüfe den Unterschied und hole den Stand in ein neues Verzeichnis, bevor du erneut pushst.",
              })
            : body.error.message,
        );
        const conflict = CodeAuthoringConflictSchema.safeParse(body.error.details);
        if (conflict.success) printDiff(ctx, conflict.data.files);
      }
      return 1;
    }
  },
};

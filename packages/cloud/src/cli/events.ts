import { link, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { assertAppEventSize } from "../_internal/app-event-schemas";
import { APP_EVENT_MAX_BYTES, AppEventEnvelopeSchema, appEventSubscriptionId } from "../contracts/app-events";
import { CapabilityQualifiedIdSchema } from "../contracts/capabilities";
import { arg, command, confirmFlag, defineCliCommands, flag } from "./commands";
import type { CloudCliContext } from "./index";
import { localizeCloudCliText } from "./locale";
import { printRows, printStructured } from "./output";

const API = "/api/app-events";
const catalogSchema = z.object({
  events: z.array(
    z.object({
      type: CapabilityQualifiedIdSchema,
      version: z.number().int().positive(),
      title: z.string(),
      description: z.string(),
      subject: CapabilityQualifiedIdSchema,
      place: CapabilityQualifiedIdSchema.nullable(),
      automation: z.boolean(),
      dataSchema: z.record(z.string(), z.unknown()),
      subscribers: z.array(z.unknown()),
    }),
  ),
});

const read = async <T>(ctx: CloudCliContext, path: string, init?: RequestInit) => ctx.readJson<T>(await ctx.fetch(`${API}${path}`, init));
const catalog = async (ctx: CloudCliContext) => catalogSchema.parse(await read(ctx, "/catalog"));

// Consume one bounded envelope at a time, including when the input has no newline.
async function* jsonLines(stream: ReadableStream<Uint8Array>, locale?: string, maxBytes?: number) {
  const t = (en: string, de: string) => localizeCloudCliText(locale, { en, de });
  const reader = stream.getReader();
  let pending = new Uint8Array(0);
  let line = 0;
  let bytesRead = 0;
  const decode = (bytes: Uint8Array) => {
    line++;
    try {
      const envelope = AppEventEnvelopeSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      assertAppEventSize(envelope);
      return envelope;
    } catch (cause) {
      throw new Error(t(`Invalid event fixture at line ${line}.`, `Ungültige Event-Fixture in Zeile ${line}.`), { cause });
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (maxBytes !== undefined && bytesRead > maxBytes) {
        throw new Error(
          t("Fixture response exceeds the requested recording budget.", "Die Fixture-Antwort überschreitet das Aufnahmebudget."),
        );
      }
      let start = 0;
      for (let index = 0; index <= value.length; index++) {
        if (index < value.length && value[index] !== 10) continue;
        const part = value.subarray(start, index);
        if (pending.length + part.length > APP_EVENT_MAX_BYTES) {
          throw new Error(
            t(
              `Event fixture line ${line + 1} exceeds ${APP_EVENT_MAX_BYTES} bytes.`,
              `Event-Fixture in Zeile ${line + 1} überschreitet ${APP_EVENT_MAX_BYTES} Bytes.`,
            ),
          );
        }
        const next = new Uint8Array(pending.length + part.length);
        next.set(pending);
        next.set(part, pending.length);
        pending = next;
        if (index < value.length) {
          if (pending.length) yield decode(pending);
          else line++;
          pending = new Uint8Array(0);
        }
        start = index + 1;
      }
    }
    if (pending.length) yield decode(pending);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

const build = (locale?: string) => {
  const t = (en: string, de: string) => localizeCloudCliText(locale, { en, de });
  const print = (ctx: CloudCliContext, value: unknown) => {
    if (!printStructured(ctx, value)) ctx.print(JSON.stringify(value, null, 2));
  };
  return defineCliCommands({
    name: "events",
    summary: t("Inspect declared app events and test local handlers.", "Deklarierte App-Events prüfen und lokale Handler testen."),
    commands: [
      command("ls", {
        summary: t("List declared event types", "Deklarierte Event-Typen auflisten"),
        flags: {
          app: flag.string({ description: t("Publisher application ID", "ID der veröffentlichenden Anwendung") }),
          automation: flag.enum(["true", "false"], {
            description: t("Filter by automation metadata", "Nach Automationsmetadaten filtern"),
          }),
        },
        async run({ ctx, flags }) {
          const result = await catalog(ctx);
          const events = result.events.filter(
            (event) =>
              (!flags.app || event.type.startsWith(`${flags.app}.`)) &&
              (flags.automation === undefined || event.automation === (flags.automation === "true")),
          );
          printRows(ctx, { events }, events, [
            { key: "type", label: "TYPE" },
            { key: "version", label: "VERSION" },
            { key: "title", label: t("TITLE", "TITEL") },
            { key: "subject", label: "SUBJECT" },
            { key: "place", label: "PLACE", value: (event) => event.place ?? "—" },
            { key: "automation", label: "AUTOMATION", value: (event) => (event.automation ? t("yes", "ja") : t("no", "nein")) },
          ]);
        },
      }),
      command("subscriptions", {
        summary: t("Inspect subscriptions and blocked reasons", "Abonnements und Sperrgründe prüfen"),
        flags: { app: flag.string({ description: t("Subscriber application ID", "ID der abonnierenden Anwendung") }) },
        run: async ({ ctx, flags }) =>
          print(ctx, await read(ctx, `/subscriptions${flags.app ? `?${new URLSearchParams({ app: flags.app })}` : ""}`)),
      }),
      command("status", {
        summary: t("Show event broker status and rejected events", "Status des Event-Brokers und abgelehnte Events anzeigen"),
        run: async ({ ctx }) => print(ctx, await read(ctx, "/status")),
      }),
      command("deliveries", {
        summary: t("List event deliveries", "Event-Zustellungen auflisten"),
        flags: {
          app: flag.string({ description: t("Subscriber application ID", "ID der abonnierenden Anwendung") }),
          state: flag.string({ description: t("Delivery state", "Zustellstatus") }),
          eventType: flag.string({ description: t("Qualified event type", "Vollständiger Event-Typ") }),
          offset: flag.int({ default: 0, min: 0, description: t("Pagination offset", "Startposition der Seite") }),
          limit: flag.int({ default: 50, min: 1, max: 100, description: t("Maximum deliveries", "Maximale Anzahl Zustellungen") }),
        },
        async run({ ctx, flags }) {
          const query = new URLSearchParams({ offset: String(flags.offset), limit: String(flags.limit) });
          for (const key of ["app", "state", "eventType"] as const) if (flags[key]) query.set(key, flags[key]);
          const result = await read<{
            items: Record<string, unknown>[];
            pagination: { offset: number; limit: number; total: number };
          }>(ctx, `/deliveries?${query}`);
          printRows(ctx, result, result.items, [
            { key: "id", label: "ID" },
            { key: "subscriptionId", label: "SUBSCRIPTION" },
            { key: "state", label: t("STATE", "STATUS") },
            { key: "attempts", label: t("ATTEMPTS", "VERSUCHE") },
            { key: "heldBy", label: t("HELD BY", "WARTET AUF") },
          ]);
        },
      }),
      command("redeliver", {
        summary: t("Redeliver one retained delivery", "Eine gespeicherte Zustellung erneut ausführen"),
        args: { id: arg.required({ description: t("Delivery ID", "Zustellungs-ID") }) },
        flags: { yes: confirmFlag() },
        async run({ ctx, args, flags }) {
          if (!flags.yes) {
            throw new Error(
              t(
                "Pass --yes to redeliver; the handler may repeat effects.",
                "Für die erneute Zustellung --yes angeben; der Handler kann Effekte wiederholen.",
              ),
            );
          }
          print(ctx, await read(ctx, `/deliveries/${encodeURIComponent(args.id)}/redeliver`, { method: "POST" }));
        },
      }),
      command("acknowledge-gap", {
        summary: t("Acknowledge a reconciled retention gap", "Eine abgeglichene Retention-Lücke bestätigen"),
        flags: { yes: confirmFlag() },
        async run({ ctx, flags }) {
          if (!flags.yes)
            throw new Error(
              t("Pass --yes after reconciling affected subscribers.", "Nach dem Abgleich betroffener Abonnenten --yes angeben."),
            );
          print(ctx, await read(ctx, "/status/acknowledge", { method: "POST" }));
        },
      }),
      command("record", {
        summary: t("Export shape-only JSONL fixtures", "JSONL-Fixtures nur mit synthetischen Daten exportieren"),
        args: { eventType: arg.required({ description: t("Qualified event type", "Vollständiger Event-Typ") }) },
        flags: {
          shapeOnly: flag.boolean({
            description: t("Required: generate synthetic fixture data", "Erforderlich: synthetische Fixture-Daten erzeugen"),
          }),
          limit: flag.int({
            default: 10,
            min: 1,
            max: 100,
            description: t("Recent events to inspect for distinct shapes", "Neueste Events für unterschiedliche Strukturen prüfen"),
          }),
          out: flag.string({ description: t("Create a JSONL file", "JSONL-Datei erstellen") }),
        },
        async run({ ctx, args, flags }) {
          if (!flags.shapeOnly) throw new Error(t("record requires --shape-only.", "record erfordert --shape-only."));
          const query = new URLSearchParams({ shapeOnly: "true", limit: String(flags.limit) });
          const response = await ctx.fetch(`${API}/record/${encodeURIComponent(args.eventType)}?${query}`);
          if (!response.ok) {
            await ctx.readJson(response);
            return;
          }
          if (!response.body) throw new Error(t("Cloud returned no fixture stream.", "Cloud hat keinen Fixture-Stream geliefert."));
          const fixtures = [];
          for await (const envelope of jsonLines(response.body, locale, flags.limit! * (APP_EVENT_MAX_BYTES + 1))) {
            if (fixtures.length >= flags.limit!) {
              throw new Error(t("Cloud returned too many fixtures.", "Cloud hat zu viele Fixtures geliefert."));
            }
            if (envelope.type !== args.eventType) {
              throw new Error(t("Cloud returned a different event type.", "Cloud hat einen anderen Event-Typ geliefert."));
            }
            fixtures.push(envelope);
          }
          if (flags.out) {
            const path = resolve(flags.out);
            const temporary = await mkdtemp(join(dirname(path), ".cloud-event-fixtures-"));
            try {
              const part = join(temporary, "fixtures.jsonl");
              await writeFile(part, fixtures.map((event) => JSON.stringify(event)).join("\n") + (fixtures.length ? "\n" : ""), {
                mode: 0o600,
              });
              await link(part, path);
            } finally {
              await rm(temporary, { recursive: true, force: true });
            }
            print(ctx, { path, count: fixtures.length });
          } else if (ctx.options.output === "json") ctx.json(fixtures);
          else for (const fixture of fixtures) await ctx.write(`${JSON.stringify(fixture)}\n`);
        },
      }),
      command("replay", {
        summary: t("Replay fixtures into a local handler", "Fixtures an einen lokalen Handler übergeben"),
        args: { fixtures: arg.required({ description: t("JSONL fixture file", "JSONL-Fixture-Datei") }) },
        flags: {
          handler: flag.string({
            required: true,
            description: t("Local module path[#export], default export by default", "Lokaler Modulpfad[#export], sonst Default-Export"),
          }),
        },
        async run({ ctx, args, flags }) {
          const current = await catalog(ctx);
          const declarations = new Map(current.events.map((event) => [event.type, event]));
          const validators = new Map<string, z.ZodType>();
          const [modulePath, exportName = "default", ...extra] = flags.handler!.split("#");
          if (!modulePath || !exportName || extra.length) {
            throw new Error(t("Use a local path[#export] for --handler.", "Für --handler einen lokalen Pfad[#export] angeben."));
          }
          const module: Record<string, unknown> = await import(pathToFileURL(resolve(modulePath)).href);
          const handler = module[exportName];
          if (typeof handler !== "function") {
            throw new Error(t("The selected handler export must be a function.", "Der gewählte Handler-Export muss eine Funktion sein."));
          }
          let delivered = 0;
          try {
            for await (const envelope of jsonLines(Bun.file(resolve(args.fixtures)).stream(), locale)) {
              const event = declarations.get(envelope.type);
              if (!event || event.version !== envelope.version) {
                throw new Error(
                  t(
                    `Event ${envelope.type}@${envelope.version} is absent from the current catalog.`,
                    `Event ${envelope.type}@${envelope.version} fehlt im aktuellen Katalog.`,
                  ),
                );
              }
              if (
                envelope.source !== envelope.type.split(".")[0] ||
                envelope.subject.type !== event.subject ||
                (envelope.place?.type ?? null) !== event.place
              ) {
                throw new Error(
                  t(
                    `Event ${envelope.type} references do not match the current catalog.`,
                    `Referenzen von Event ${envelope.type} passen nicht zum aktuellen Katalog.`,
                  ),
                );
              }
              let validator = validators.get(envelope.type);
              if (!validator) {
                validator = z.fromJSONSchema(structuredClone(event.dataSchema));
                validators.set(envelope.type, validator);
              }
              validator.parse(envelope.data);
              await handler(envelope, {
                subscriptionId: appEventSubscriptionId("replay", envelope.type, envelope.version),
                eventId: envelope.id,
                attempt: 1,
                signal: new AbortController().signal,
              });
              delivered++;
            }
          } catch (cause) {
            const detail = cause instanceof Error ? cause.message : String(cause);
            throw new Error(
              t(
                `Replay stopped after ${delivered} completed fixtures: ${detail}`,
                `Replay wurde nach ${delivered} abgeschlossenen Fixtures angehalten: ${detail}`,
              ),
              { cause },
            );
          }
          print(ctx, { delivered });
        },
      }),
    ],
  });
};

const eventsCliModule = build();
export default {
  ...eventsCliModule,
  help: (locale?: string) => build(locale).help?.(locale) ?? "",
  run: (ctx: CloudCliContext) => build(ctx.options.locale).run(ctx),
};

import type { GeoIpAdminStatus, GeoIpResetResult } from "../../contracts/geoip";
import { arg, type CloudCliContext, cliText, command, confirmFlag, printStructured } from "../index";

const path = "/api/admin/core/geoip";
const messages = {
  geoip_too_large: {
    en: "The database exceeds 192 MiB unpacked. Try a smaller database.",
    de: "Die Datenbank überschreitet 192 MiB entpackt. Nutze eine kleinere Datenbank.",
  },
  geoip_request_too_large: {
    en: "The compressed upload exceeds 128 MiB. Try a smaller database.",
    de: "Der komprimierte Upload überschreitet 128 MiB. Nutze eine kleinere Datenbank.",
  },
  geoip_empty: { en: "The uploaded file is empty.", de: "Die hochgeladene Datei ist leer." },
  geoip_invalid: {
    en: "Upload a valid IPv6 MMDB database with a build date.",
    de: "Lade eine gültige IPv6-MMDB-Datenbank mit Erstellungsdatum hoch.",
  },
  geoip_unsupported_type: { en: "Only City and ASN databases are supported.", de: "Nur City- und ASN-Datenbanken werden unterstützt." },
  geoip_upload_busy: {
    en: "Another upload is running. Try again shortly.",
    de: "Ein anderer Upload läuft. Versuche es gleich noch einmal.",
  },
} as const;
const readStatus = async <T extends GeoIpAdminStatus = GeoIpAdminStatus>(ctx: CloudCliContext, response: Response): Promise<T> => {
  if (!response.ok) {
    const value: unknown = await response
      .clone()
      .json()
      .catch(() => null);
    if (typeof value === "object" && value !== null && "code" in value) {
      for (const [code, message] of Object.entries(messages)) if (value.code === code) throw new Error(cliText(ctx, message));
    }
  }
  return ctx.readJson<T>(response);
};
const printStatus = (ctx: CloudCliContext, status: GeoIpAdminStatus) => {
  if (printStructured(ctx, status)) return;
  ctx.table(
    status.databases.map((database) => ({
      type: database.kind,
      source: database.source ?? "-",
      databaseType: database.databaseType ?? "-",
      built: database.buildDate ?? "-",
      stale: database.stale,
      uploadedBy: database.upload?.uploadedBy?.name ?? "-",
      uploadedAt: database.upload?.uploadedAt ?? "-",
    })),
    [
      { key: "type" },
      { key: "source" },
      { key: "databaseType" },
      { key: "built" },
      { key: "stale" },
      { key: "uploadedBy" },
      { key: "uploadedAt" },
    ],
  );
  if (status.attribution) ctx.print(`${status.attribution.text} (${status.attribution.url}), ${status.attribution.license}`);
};
export const geoipCommands = [
  command("geoip status", {
    summary: "Show sign-in location databases and their build dates",
    async run({ ctx }) {
      printStatus(ctx, await readStatus(ctx, await ctx.fetch(path)));
    },
  }),
  command("geoip upload", {
    summary: "Replace a sign-in location database from an MMDB or gzip file",
    args: { file: arg.required({ valueLabel: "file" }) },
    async run({ ctx, args }) {
      const file = Bun.file(args.file);
      if (!(await file.exists())) throw new Error(cliText(ctx, { en: "File not found.", de: "Datei nicht gefunden." }));
      // Refresh credentials on a replayable request before sending a one-shot stream. A token with only the write
      // scope may not read the status; the upload's own answer reports whether it is allowed.
      const preflight = await ctx.fetch(path);
      if (preflight.status === 403) await preflight.body?.cancel();
      else await readStatus(ctx, preflight);
      const magic = new Uint8Array(await file.slice(0, 2).arrayBuffer());
      const gzip = magic[0] === 0x1f && magic[1] === 0x8b;
      const body = gzip ? file.stream() : file.stream().pipeThrough(new CompressionStream("gzip"));
      try {
        const init: RequestInit & { duplex: "half" } = {
          method: "PUT",
          headers: { "Content-Type": "application/gzip" },
          body,
          duplex: "half",
        };
        printStatus(ctx, await readStatus(ctx, await ctx.fetch(path, init)));
      } finally {
        if (!body.locked) await body.cancel().catch(() => {});
      }
    },
  }),
  command("geoip reset", {
    summary: "Return one or both sign-in location databases to the bundled snapshot",
    args: { kind: arg.optional({ valueLabel: "city|asn" }) },
    flags: { yes: confirmFlag("Reset sign-in location databases") },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error(cliText(ctx, { en: "Refusing to reset without --yes.", de: "Ohne --yes wird nicht zurückgesetzt." }));
      if (args.kind !== undefined && args.kind !== "city" && args.kind !== "asn")
        throw new Error(cliText(ctx, { en: "Choose city or asn.", de: "Wähle city oder asn." }));
      let status: GeoIpResetResult | undefined;
      let changed = false;
      for (const kind of args.kind ? [args.kind] : ["city", "asn"]) {
        status = await readStatus<GeoIpResetResult>(ctx, await ctx.fetch(`${path}/${kind}`, { method: "DELETE" }));
        changed ||= status.changed;
      }
      if (status) {
        status.changed = changed;
        printStatus(ctx, status);
      }
    },
  }),
];

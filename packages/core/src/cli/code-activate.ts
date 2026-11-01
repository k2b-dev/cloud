import { type CloudCliContext, localizeCloudCliText, printStructured } from "@k2b/cloud/cli";
import { z } from "zod";
import { CodeActivationSchema } from "../code/activation-contracts";
import type { CodeAuthoringData } from "../code/authoring-contracts";
import { RemoteCodeError, request } from "./code-request";

/** Same bound as the Code page: activation keeps going durably in Core after the wait ends. */
const ACTIVATION_WAIT_MS = 90_000;
const ACTIVATION_POLL_MS = 1_000;
/** One target that does not answer must not hold the terminal; a missing answer is a visible state here. */
const ROUTE_TIMEOUT_MS = 30_000;

/** The fields this command shows from Core's activation preview; Core's contract stays the authority and may add fields. */
const PreviewSchema = z.object({
  title: z.string(),
  number: z.number(),
  running: z.number().nullable(),
  latest: z.number(),
  activated: z.object({ at: z.string() }).nullable(),
  allowed: z.discriminatedUnion("allowed", [
    z.object({ allowed: z.literal(true) }),
    z.object({ allowed: z.literal(false), reason: z.enum(["phone", "credential"]) }),
  ]),
  readiness: z.discriminatedUnion("state", [
    z.object({ state: z.literal("ready") }),
    z.object({ state: z.literal("approval_pending") }),
    z.object({ state: z.literal("refused"), code: z.string(), message: z.string() }),
  ]),
  place: z.object({ title: z.string(), typeTitle: z.string().nullable(), href: z.string().nullable() }).nullable(),
  rows: z.array(
    z.object({
      target: z.object({ type: z.string(), id: z.string() }),
      operations: z.array(z.string()),
      own: z.boolean(),
      isNew: z.boolean(),
      check: z.enum(["manages", "blocked", "has", "unknown"]),
      title: z.string().nullable(),
      typeTitle: z.string().nullable(),
      managers: z.array(z.object({ name: z.string(), firstName: z.string().nullable() })),
    }),
  ),
});
type Preview = z.infer<typeof PreviewSchema>;
type Row = Preview["rows"][number];

const route = async <T extends z.ZodType>(ctx: CloudCliContext, path: string, body: unknown, schema: T): Promise<z.output<T> | null> => {
  try {
    const response = await ctx.fetch(`/api/code/activation/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const parsed = z.object({ data: schema }).safeParse(await response.json());
    return parsed.success ? parsed.data.data : null;
  } catch {
    return null;
  }
};

const texts = (ctx: CloudCliContext) => (en: string, de: string) => localizeCloudCliText(ctx.options.locale, { en, de });

/** "Nothing switched on" names what keeps running, so the person knows nothing got worse. */
const nothingChanged = (ctx: CloudCliContext, running: number | null) => {
  const t = texts(ctx);
  return running === null
    ? t("Nothing switched on.", "Nichts eingeschaltet.")
    : t(`Nothing switched on; v${running} keeps running.`, `Nichts eingeschaltet, v${running} läuft weiter.`);
};
const targetName = (row: Pick<Row, "title" | "typeTitle" | "target">) =>
  row.title ? [row.typeTitle, row.title].filter(Boolean).join(" ") : row.target.id;

/** Operation, where it applies and what this person's switching on would do there. */
function printRows(ctx: CloudCliContext, preview: Preview) {
  const t = texts(ctx);
  const running = preview.running;
  const place = (row: Row) => {
    if (row.own) return t(`at own ${preview.place?.typeTitle ?? "owner"}`, `am eigenen ${preview.place?.typeTitle ?? "Besitzer"}`);
    return row.title ? `${t("at", "an")} ${targetName(row)} (${row.target.id})` : `${t("at", "an")} ${row.target.id}`;
  };
  const verdict = (row: Row) => {
    if (row.check === "has") return `✓ ${t(`v${running ?? preview.number} already has it`, `hat v${running ?? preview.number} schon`)}`;
    if (row.check === "blocked") return `✗ ${t("you are not an administrator", "du bist nicht Admin")}`;
    if (row.check === "unknown") return `? ${t("checked when switching on", "wird beim Einschalten geprüft")}`;
    return row.own
      ? `✓ ${t(`you administer ${row.title ?? preview.place?.title ?? row.target.id}`, `du verwaltest ${row.title ?? preview.place?.title ?? row.target.id}`)}`
      : `✓ ${t("you administer it", "du verwaltest ihn")}`;
  };
  const isNew = (row: Row) => {
    if (!row.isNew) return "";
    if (row.own || !row.typeTitle) return `← ${t("new", "neu")}  `;
    return `← ${t(`new, needs the administrator of the ${row.typeTitle}`, `neu, braucht den Admin des ${row.typeTitle}`)}  `;
  };
  const lines = preview.rows.map((row) => ({
    operation: row.operations.join(" · ") || "—",
    where: place(row),
    end: `${isNew(row)}${verdict(row)}`,
  }));
  const width = Math.max(0, ...lines.map((line) => line.operation.length));
  const whereWidth = Math.max(0, ...lines.map((line) => line.where.length));
  ctx.print(t("Access from the handles in the code (operation at target):", "Rechte aus den Handles im Code (Operation an Ziel):"));
  for (const line of lines) ctx.print(`  ${line.operation.padEnd(width)}   ${line.where.padEnd(whereWidth)}   ${line.end}`);
}

/** The refusal names the target and, only when the person may read it, who manages it and where they find the Code. */
function printBlocked(ctx: CloudCliContext, preview: Preview, row: Pick<Row, "target" | "title" | "typeTitle" | "own" | "managers">) {
  const t = texts(ctx);
  const server = ctx.options.server.replace(/\/$/, "");
  const name = targetName(row);
  const owner = preview.place ? [preview.place.typeTitle, preview.place.title].filter(Boolean).join(" ") : null;
  ctx.print(
    `✗ ${t(`You are not an administrator of ${name}.`, `Du bist nicht Admin von ${name}.`)}${
      row.title && owner && !row.own
        ? ` ${t(`Only someone who administers ${owner} and ${name} can switch it on.`, `Einschalten kann nur, wer ${owner} und ${name} verwaltet.`)}`
        : ""
    }`,
  );
  const managers = row.title ? row.managers : [];
  ctx.print(
    `  ${[managers.length > 0 ? t(`Here that is ${managers.map((m) => m.name).join(", ")}.`, `Das kann hier: ${managers.map((m) => m.name).join(", ")}.`) : "", nothingChanged(ctx, preview.running)].filter(Boolean).join(" ")}`,
  );
  if (preview.place?.href) {
    const url = new URL(preview.place.href, `${server}/`).href;
    const first = managers.length === 1 ? (managers[0]!.firstName ?? managers[0]!.name) : null;
    ctx.print(`  ${first ? t(`Link for ${first}`, `Link für ${first}`) : "Link"}: ${url}`);
  }
}

/** Reads what switching on would do, asks once, starts Core's durable activation and reports how it ended. */
export async function runCodeActivation(
  ctx: CloudCliContext,
  input: { codeId: string; versionId: string; activationId: string | undefined; yes: boolean },
): Promise<number> {
  const t = texts(ctx);
  const structured = ctx.options.output !== "text";
  if (ctx.options.ci) throw new Error(t("CI may push Code but cannot activate it.", "CI darf Code pushen, aber nie einschalten."));
  // Scripts stay exactly on the published contract: they confirm explicitly and keep their identity for a retry.
  if (!input.yes && (structured || !ctx.confirm))
    throw new Error(
      t(
        "Activation asks before it switches anything on. Without a terminal, confirm with --yes.",
        "Einschalten fragt vorher nach. Ohne Terminal bestätige mit --yes.",
      ),
    );
  if (!input.activationId && (structured || !ctx.confirm))
    throw new Error(t("Without a terminal, --activation-id is required.", "Ohne Terminal ist --activation-id nötig."));
  const activationId = input.activationId ?? crypto.randomUUID();
  const start = () => request(ctx, "activate", { codeId: input.codeId, versionId: input.versionId, activationId });
  if (structured) {
    const data = await start();
    printStructured(ctx, data);
    return ["failed", "cancelled"].includes(data.activation.state) ? 1 : 0;
  }
  const preview = await route(ctx, "preview", { codeId: input.codeId, versionId: input.versionId }, PreviewSchema);
  if (!preview && !input.yes)
    throw new RemoteCodeError({
      version: 1,
      error: {
        code: "code_activation_preview_unavailable",
        message: t(
          "Cloud could not say what switching on would do, so nothing was switched on. Try again.",
          "Cloud konnte nicht sagen, was das Einschalten bewirkt, darum wurde nichts eingeschaltet. Versuche es erneut.",
        ),
        details: null,
      },
    });
  if (preview) {
    if (preview.activated) {
      ctx.print(`✓ ${t(`v${preview.number} is already switched on.`, `v${preview.number} ist schon eingeschaltet.`)}`);
      return 0;
    }
    ctx.print(
      `${t(`Switch on version ${preview.number} of “${preview.title}”.`, `Version ${preview.number} von „${preview.title}“ einschalten.`)} ${
        preview.place
          ? t(`The Code then acts on behalf of ${preview.place.title}.`, `Der Code handelt dann im Namen von ${preview.place.title}.`)
          : t("The Code then runs as you.", "Der Code läuft dann als du.")
      }`,
    );
    ctx.print(t("Address: none, only automations", "Adresse: keine, nur Automationen"));
    if (preview.rows.length > 0) printRows(ctx, preview);
    if (!preview.allowed.allowed) {
      ctx.print(
        `✗ ${
          preview.allowed.reason === "phone"
            ? t("Code cannot be switched on from a phone.", "Code lässt sich nicht vom Telefon einschalten.")
            : t(
                "Only a person's sign-in can switch Code on, not an API key.",
                "Einschalten geht nur mit der Anmeldung einer Person, nicht mit einem API-Schlüssel.",
              )
        } ${nothingChanged(ctx, preview.running)}`,
      );
      return 1;
    }
    if (preview.readiness.state === "approval_pending") {
      ctx.print(
        `✗ ${t(`v${preview.number} still waits for approval by a Cloud administrator.`, `v${preview.number} wartet noch auf die Freigabe durch einen Cloud-Admin.`)} ${nothingChanged(ctx, preview.running)}`,
      );
      return 1;
    }
    if (preview.readiness.state === "refused") {
      ctx.print(`✗ ${preview.readiness.message} ${nothingChanged(ctx, preview.running)}`);
      return 1;
    }
    const blocked = preview.rows.find((row) => row.check === "blocked");
    if (blocked) {
      printBlocked(ctx, preview, blocked);
      return 1;
    }
    // An older version has no list to confirm: naming it explicitly with --yes stays possible.
    if (preview.number < preview.latest && !input.yes) {
      ctx.print(
        `✗ ${t(`v${preview.latest} is newer. Confirm an older version with --yes.`, `v${preview.latest} ist neuer. Bestätige eine ältere Version mit --yes.`)} ${nothingChanged(ctx, preview.running)}`,
      );
      return 1;
    }
  }
  if (!input.yes && !(await ctx.confirm!(t("Switch on? [y/N] ", "Einschalten? [j/N] ")))) {
    ctx.print(nothingChanged(ctx, preview?.running ?? null));
    return 1;
  }
  let activation: CodeAuthoringData<"activate">["activation"];
  try {
    ({ activation } = await start());
  } catch (error) {
    // Without a definite refusal Core may have started it; the same identity reads or resumes that very activation.
    if (!(error instanceof RemoteCodeError) || /^(http_5|code_authoring_failed)/.test(error.body.error.code))
      ctx.error(
        t(
          `No clear answer from Cloud. Ask again with --activation-id ${activationId}.`,
          `Keine klare Antwort von Cloud. Frage erneut mit --activation-id ${activationId}.`,
        ),
      );
    throw error;
  }
  const number = preview?.number;
  const label = number ? `v${number}` : t("The version", "Die Version");
  const done = () => ["active", "failed", "cancelled"].includes(activation.state);
  // Only a person at a terminal waits for the outcome; a script keeps the immediate receipt.
  const deadline = Date.now() + ACTIVATION_WAIT_MS;
  while (ctx.confirm && !done() && Date.now() < deadline) {
    const read = await route(ctx, "read", { codeId: input.codeId, activationId }, CodeActivationSchema);
    if (read) activation = read;
    if (!done()) await Bun.sleep(ACTIVATION_POLL_MS);
  }
  if (activation.state === "active") {
    const when = new Intl.DateTimeFormat(ctx.options.locale, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(activation.updatedAt),
    );
    ctx.print(`✓ ${t(`${label} switched on by you · ${when}`, `${label} eingeschaltet von dir · ${when}`)}`);
    return 0;
  }
  if (activation.state === "failed" || activation.state === "cancelled") {
    const failure = activation.failure;
    if (failure?.code === "not_manager" && preview) {
      const known = preview.rows.find((item) => item.target.type === failure.target?.type && item.target.id === failure.target?.id);
      // Core's current reader check decides now, also when access changed since the preview.
      const readable = failure.readable !== false;
      printBlocked(ctx, preview, {
        target: failure.target ?? { type: "", id: "" },
        title: readable ? (failure.title ?? known?.title ?? null) : null,
        typeTitle: readable ? (known?.typeTitle ?? null) : null,
        own: known?.own ?? false,
        managers: readable ? (failure.managerNames?.map((name) => ({ name, firstName: null })) ?? known?.managers ?? []) : [],
      });
      return 1;
    }
    ctx.print(
      `✗ ${failure?.reason ?? t("Switching on did not finish.", "Das Einschalten wurde nicht abgeschlossen.")} ${nothingChanged(ctx, preview?.running ?? null)}`,
    );
    return 1;
  }
  if (!ctx.confirm) {
    ctx.print(`${activation.id} · ${activation.state}`);
    return 0;
  }
  ctx.print(
    t(
      `Cloud keeps working on this by itself. Check with --activation-id ${activationId} --yes.`,
      `Cloud arbeitet von selbst weiter daran. Prüfe den Stand mit --activation-id ${activationId} --yes.`,
    ),
  );
  return 0;
}

/** "v5 uploaded, not switched on yet. v4 is running." */
export function printCodeSubmission(ctx: CloudCliContext, data: CodeAuthoringData<"push">) {
  const t = texts(ctx);
  const number = data.submission.version.number;
  const running = data.runningVersion;
  const uploaded = t(`v${number} uploaded, not switched on yet.`, `v${number} hochgeladen, noch nicht eingeschaltet.`);
  // Absent means it could not be read; only null says that none runs.
  const state =
    running === undefined
      ? ""
      : running === null
        ? ` ${t("No version is running.", "Es läuft noch keine Version.")}`
        : ` ${t(`v${running} is running.`, `Es läuft v${running}.`)}`;
  ctx.print(`✓ ${uploaded}${state}`);
  if (data.submission.status === "pending")
    ctx.print(t("  It waits for approval by a Cloud administrator.", "  Sie wartet auf die Freigabe durch einen Cloud-Admin."));
}

import { arg, type CloudCliContext, command, flag, localizeCloudCliText, printStructured } from "@k2b/cloud/cli";
import { APP_APPROVAL_LIMITS } from "@k2b/cloud/contracts";
import { CODE_REVIEW_MAX_WAIT_MS, type CodeReview } from "../code/review-contracts";
import { loadCodeProject } from "./code-files";
import { request } from "./code-request";

export function codeReviewExitCode(review: CodeReview): number {
  switch (review.status) {
    case "approved":
    case "not_required":
      return 0;
    case "changes_requested":
      return 10;
    case "rejected":
      return 11;
    case "withdrawn":
    case "superseded":
    case "expired":
      return 12;
    case "pending":
      return 13;
  }
}
export function printCodeReview(ctx: CloudCliContext, review: CodeReview) {
  if (printStructured(ctx, review)) return;
  const t = (en: string, de: string) => localizeCloudCliText(ctx.options.locale, { en, de });
  const status: Record<CodeReview["status"], string> = {
    approved: t("Approved", "Freigegeben"),
    not_required: t("No admin approval needed", "Keine Admin-Freigabe nötig"),
    pending: t("Waiting for an admin", "Wartet auf Admin"),
    changes_requested: t("Changes requested", "Änderungen angefordert"),
    rejected: t("Rejected", "Abgelehnt"),
    withdrawn: t("Withdrawn", "Zurückgezogen"),
    superseded: t("Superseded", "Ersetzt"),
    expired: t("Approval expired", "Freigabe abgelaufen"),
  };
  ctx.print(`${review.codeId} · ${t("Version", "Version")} ${review.number}: ${status[review.status]}`);
  if (review.decidedAt) ctx.print(`${review.decidedBy?.name ?? t("An admin", "Ein Admin")} · ${review.decidedAt}`);
  if (review.message) ctx.print(review.message);
  for (const comment of review.comments) ctx.print(`${comment.path ?? ""}${comment.line ? `:${comment.line}` : ""}  ${comment.body}`);
  if (review.nextBefore)
    ctx.print(
      t(`More comments: review show --before ${review.nextBefore}`, `Weitere Kommentare: review show --before ${review.nextBefore}`),
    );
  ctx.print(
    review.activeVersion
      ? t(`Version ${review.activeVersion.number} remains on.`, `Version ${review.activeVersion.number} bleibt eingeschaltet.`)
      : t("The automation remains off.", "Die Automation bleibt aus."),
  );
  if (review.status === "approved" || review.status === "not_required")
    ctx.print(
      t(
        "Next: review the activation and switch on with code activate.",
        "Nächster Schritt: Einschalten prüfen und mit code activate einschalten.",
      ),
    );
  else if (review.status === "changes_requested" || review.status === "rejected")
    ctx.print(
      t("Next: revise, check and submit a new version.", "Nächster Schritt: überarbeiten, prüfen und eine neue Version einreichen."),
    );
  else if (review.status === "expired")
    ctx.print(
      t(
        "Next: submit again; this creates a new version and a fresh review.",
        "Nächster Schritt: noch einmal einreichen; das legt eine neue Version und Prüfung an.",
      ),
    );
  else if (review.status === "pending")
    ctx.print(
      t(
        "Next: wait. Ctrl+C stops waiting and leaves the review pending.",
        "Nächster Schritt: warten. Strg+C beendet das Warten; die Freigabe wartet weiter.",
      ),
    );
  else ctx.print(t("Next: read the latest version with code status.", "Nächster Schritt: neueste Version mit code status lesen."));
}

export function codeReviewCommands(locale?: string) {
  const t = (en: string, de: string) => localizeCloudCliText(locale, { en, de });
  const args = { project: arg.optional({ description: t("Local Code project", "Lokales Code-Projekt") }) };
  const version = flag.string({ description: t("Version UUID; defaults to code.json", "Versions-UUID; Standard aus code.json") });
  return [
    command("review show", {
      summary: t("Read a version's decision and line comments", "Entscheidung und Zeilenkommentare einer Version lesen"),
      args,
      flags: {
        version,
        before: flag.string({ description: t("Continue comments from nextBefore", "Kommentare ab nextBefore weiterlesen") }),
      },
      async run({ ctx, args, flags }) {
        const { config } = await loadCodeProject(args.project);
        const versionId = flags.version ?? config.baseVersionId;
        if (!versionId)
          throw new Error(t("Submit a version first or supply --version.", "Reiche zuerst eine Version ein oder nutze --version."));
        const review = await request(ctx, "review", { codeId: config.codeId, versionId, before: flags.before });
        printCodeReview(ctx, review);
        return codeReviewExitCode(review);
      },
    }),
    command("review wait", {
      summary: t(
        "Wait for an admin decision without cancelling it on Ctrl+C",
        "Auf Admin-Entscheidung warten; Strg+C zieht die Anfrage nicht zurück",
      ),
      args,
      flags: {
        version,
        timeout: flag.int({
          min: 1,
          max: CODE_REVIEW_MAX_WAIT_MS / 1000,
          default: CODE_REVIEW_MAX_WAIT_MS / 1000,
          description: t("Maximum wait in seconds (up to 14 days)", "Wartezeit in Sekunden (höchstens 14 Tage)"),
        }),
      },
      async run({ ctx, args, flags }) {
        const { config } = await loadCodeProject(args.project);
        const versionId = flags.version ?? config.baseVersionId;
        if (!versionId)
          throw new Error(t("Submit a version first or supply --version.", "Reiche zuerst eine Version ein oder nutze --version."));
        ctx.error(
          t(
            `Waiting for the review of ${config.codeId}, version ${versionId}. Ctrl+C only stops waiting.`,
            `Warte auf die Prüfung von ${config.codeId}, Version ${versionId}. Strg+C beendet nur das Warten.`,
          ),
        );
        const cancelled = new AbortController();
        const stop = () => cancelled.abort();
        process.once("SIGINT", stop);
        const deadline = Date.now() + flags.timeout! * 1000;
        const timeout = AbortSignal.timeout(flags.timeout! * 1000);
        const signal = AbortSignal.any([cancelled.signal, timeout]);
        let review: CodeReview | undefined;
        try {
          do {
            const started = Date.now();
            review = await request(
              ctx,
              "reviewWait",
              {
                codeId: config.codeId,
                versionId,
                holdMs: Math.min(APP_APPROVAL_LIMITS.pollSeconds * 1000, Math.max(0, deadline - Date.now())),
              },
              signal,
            );
            if (review.status !== "pending") break;
            // An overloaded server answers immediately. Pace the next request without busy polling.
            await new Promise<void>((resolve) => {
              const timer = setTimeout(done, Math.max(0, APP_APPROVAL_LIMITS.pollSeconds * 1000 - (Date.now() - started)));
              function done() {
                clearTimeout(timer);
                signal.removeEventListener("abort", done);
                resolve();
              }
              signal.addEventListener("abort", done, { once: true });
              if (signal.aborted) done();
            });
          } while (!signal.aborted);
        } catch (error) {
          if (!signal.aborted) throw error;
        } finally {
          process.removeListener("SIGINT", stop);
        }
        if (cancelled.signal.aborted) {
          ctx.error(t("Stopped waiting. The review is unchanged.", "Warten beendet. Die Freigabe bleibt unverändert."));
          return 13;
        }
        // A timeout still returns the last verified review as the exact JSON contract.
        if (signal.aborted || !review) review = await request(ctx, "review", { codeId: config.codeId, versionId });
        printCodeReview(ctx, review);
        return codeReviewExitCode(review);
      },
    }),
  ];
}

import { arg, command, confirmFlag, flag } from "@valentinkolb/cloud/cli";
import { EvidenceExportRequestSchema } from "../evidence-export-contracts";
import { verifyEvidencePackage } from "../evidence-package-verifier";
import { baseArgs, baseFlag, requirePublicId, resolveBaseFromCommand } from "./resources";
import { JSON_BODY_INPUT, jsonRequest, printCliStructured, queryString, readApi, readJsonInput, writeApiFile } from "./runtime";

const countText = (counts: Record<string, number> | null): string =>
  counts
    ? Object.entries(counts)
        .map(([name, count]) => `${name} ${count}`)
        .join(", ") || "none"
    : "unavailable";

export const evidenceCommands = [
  command("evidence preflight", {
    summary: "Inspect available evidence and estimate an export without creating it",
    args: baseArgs,
    flags: { ...baseFlag, body: JSON_BODY_INPUT },
    async run({ ctx, args, flags }) {
      const scope = EvidenceExportRequestSchema.parse((await readJsonInput(flags.body, "evidence scope", false)) ?? {});
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const result = await readApi<unknown>(
        ctx,
        `/evidence-exports/by-base/${base.id}/preflight${queryString({
          ...scope,
          sections: scope.sections.join(","),
        })}`,
      );
      if (!printCliStructured(ctx, result)) ctx.json(result);
    },
  }),
  command("evidence list", {
    summary: "List retained evidence export requests in a Base",
    args: baseArgs,
    flags: baseFlag,
    async run({ ctx, args }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const result = await readApi<unknown>(ctx, `/evidence-exports/by-base/${base.id}`);
      if (!printCliStructured(ctx, result)) ctx.json(result);
    },
  }),
  command("evidence create", {
    summary: "Request an evidence export using the Base administrator permission",
    args: baseArgs,
    flags: { ...baseFlag, body: JSON_BODY_INPUT, yes: confirmFlag("Create an evidence package") },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to request an evidence export.");
      const scope = EvidenceExportRequestSchema.parse((await readJsonInput(flags.body, "evidence scope", false)) ?? {});
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const result = await readApi<unknown>(ctx, `/evidence-exports/by-base/${base.id}`, jsonRequest("POST", scope));
      if (!printCliStructured(ctx, result)) ctx.json(result);
    },
  }),
  command("evidence get", {
    summary: "Read an evidence export status, hashes and coverage",
    args: { id: arg.required({ description: "Evidence export public ID" }) },
    async run({ ctx, args }) {
      const result = await readApi<unknown>(ctx, `/evidence-exports/${requirePublicId(args.id, "Export")}`);
      if (!printCliStructured(ctx, result)) ctx.json(result);
    },
  }),
  ...(["retry", "cancel"] as const).map((action) =>
    command(`evidence ${action}`, {
      summary: action === "retry" ? "Retry a failed evidence export" : "Request cancellation of an evidence export",
      args: { id: arg.required({ description: "Evidence export public ID" }) },
      flags: { yes: confirmFlag(`${action} the evidence export`) },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error(`Pass --yes to ${action} the evidence export.`);
        const result = await readApi<unknown>(
          ctx,
          `/evidence-exports/${requirePublicId(args.id, "Export")}/${action}`,
          jsonRequest("POST"),
        );
        if (!printCliStructured(ctx, result)) ctx.json(result);
      },
    }),
  ),
  command("evidence download", {
    summary: "Download the exact completed evidence TAR without rendering again",
    args: { id: arg.required({ description: "Evidence export public ID" }) },
    flags: { out: flag.string({ required: true, description: "Destination TAR path" }) },
    async run({ ctx, args, flags }) {
      await writeApiFile(ctx, `/evidence-exports/${requirePublicId(args.id, "Export")}/download`, undefined, flags.out);
    },
  }),
  command("evidence verify", {
    summary: "Verify a downloaded Grids evidence package offline",
    requiresCloud: false,
    description:
      "Reads the TAR locally without extracting or uploading it. Matching hashes prove byte agreement and declared coverage, not compliance, authorship, custody, or legal validity.",
    args: { package: arg.required({ valueLabel: "package.tar", description: "Downloaded Grids evidence TAR" }) },
    flags: {
      sha256: flag.string({ description: "Expected SHA-256 of the complete TAR" }),
      manifestSha256: flag.string({ name: "manifest-sha256", description: "Expected SHA-256 of manifest.json" }),
    },
    examples: [
      "cld grids evidence verify bookshop-evidence-2026-08-19.tar",
      "cld grids evidence verify package.tar --sha256 <package-sha256> --manifest-sha256 <manifest-sha256> --json",
    ],
    async run({ ctx, args, flags }) {
      const result = await verifyEvidencePackage(args.package, {
        packageSha256: flags.sha256,
        manifestSha256: flags.manifestSha256,
      });
      if (!printCliStructured(ctx, result)) {
        ctx.print(result.valid ? "Evidence package verified." : "Evidence package verification failed.");
        if (result.package.sha256) ctx.print(`Package SHA-256: ${result.package.sha256}`);
        if (result.manifest.sha256) ctx.print(`Manifest SHA-256: ${result.manifest.sha256}`);
        if (result.scope && result.consistency) {
          ctx.print(`Scope: Base ${result.scope.baseId}${result.scope.tableId ? `, table ${result.scope.tableId}` : ""}`);
          ctx.print(`Cut: ${result.consistency.cutAt}`);
          ctx.print(`Sections: ${result.scope.sections.join(", ")}`);
        }
        ctx.print(`Counts: ${countText(result.counts)}`);
        if (result.coverage) ctx.print(`Coverage: ${result.coverage.note}`);
        ctx.print(`Verified entries: ${result.verifiedEntries}`);
        for (const issue of result.issues) ctx.print(`- ${issue.path ? `${issue.path}: ` : ""}${issue.message}`);
        ctx.print("Hash agreement does not establish compliance, authorship, custody, or legal validity.");
      }
      return result.valid ? 0 : 1;
    },
  }),
] as const;

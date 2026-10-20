import { open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { arg, command, confirmFlag, flag } from "@k2b/cloud/cli";
import { requireRestArg, resolveBaseFromCommand, resolveSource } from "./context";
import { baseFlag } from "./flags";
import { keyRows } from "./rows";
import { exactMatch, jsonRequest, printJsonOrTable, printMessage, printStructured, readApi } from "./shared";
import type { PulseSourceApiKey, SourceApiKeyCreateResult } from "./types";

export const sourceTokenCommands = [
  command("source-tokens list", {
    summary: "List HTTP ingest tokens for a source",
    flags: baseFlag,
    args: { args: arg.rest({ valueLabel: "base source", required: true }) },
    async run({ ctx, args }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, 1);
      const source = await resolveSource(ctx, base.id, requireRestArg(rest, 0, "source"));
      const keys = await readApi<PulseSourceApiKey[]>(
        ctx,
        `/bases/${encodeURIComponent(base.id)}/sources/${encodeURIComponent(source.id)}/api-keys`,
      );
      printJsonOrTable(ctx, keys, keyRows(keys), [
        { key: "id" },
        { key: "name" },
        { key: "prefix" },
        { key: "permission" },
        { key: "expiresAt" },
        { key: "lastUsedAt" },
      ]);
    },
  }),
  command("source-tokens create", {
    summary: "Create an HTTP ingest token for a source",
    flags: {
      ...baseFlag,
      name: flag.string({ required: true, description: "Token label" }),
      expiresAt: flag.string({ name: "expires-at", description: "ISO expiry timestamp" }),
      outputFile: flag.string({ name: "output-file", required: true, description: "Write the token to a new file (mode 0600)" }),
    },
    args: { args: arg.rest({ valueLabel: "base source", required: true }) },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, 1);
      const source = await resolveSource(ctx, base.id, requireRestArg(rest, 0, "source"));
      if (!flags.outputFile) throw new Error("--output-file is required");
      const path = resolve(flags.outputFile);
      // Reserve the exact path before minting a credential. Never truncate an existing file.
      const file = await open(path, "wx", 0o600);
      let complete = false;
      try {
        const result = await readApi<SourceApiKeyCreateResult>(
          ctx,
          `/bases/${encodeURIComponent(base.id)}/sources/${encodeURIComponent(source.id)}/api-keys`,
          jsonRequest("POST", { name: flags.name, permission: "write", expiresAt: flags.expiresAt ?? null }),
        );
        await file.writeFile(result.token, "utf8");
        complete = true;
        const metadata = { id: result.credential.id, name: result.credential.name, path };
        if (!printStructured(ctx, metadata)) ctx.print(`Created token ${metadata.name} (${metadata.id}). Saved to ${path}.`);
      } finally {
        await file.close();
        if (!complete) await unlink(path);
      }
    },
  }),
  command("source-tokens revoke", {
    summary: "Revoke an HTTP ingest token",
    flags: { ...baseFlag, yes: confirmFlag("Revoke this token") },
    args: { args: arg.rest({ valueLabel: "base source token", required: true }) },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Refusing to revoke without --yes.");
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, 2);
      const source = await resolveSource(ctx, base.id, requireRestArg(rest, 0, "source"));
      const tokenRef = requireRestArg(rest, 1, "token");
      const keys = await readApi<PulseSourceApiKey[]>(
        ctx,
        `/bases/${encodeURIComponent(base.id)}/sources/${encodeURIComponent(source.id)}/api-keys`,
      );
      const key = exactMatch(keys, tokenRef, [(item) => item.id, (item) => item.name, (item) => item.tokenPrefix], "token");
      await readApi<unknown>(
        ctx,
        `/bases/${encodeURIComponent(base.id)}/sources/${encodeURIComponent(source.id)}/api-keys/${encodeURIComponent(key.id)}`,
        jsonRequest("DELETE"),
      );
      printMessage(ctx, { revoked: key.id }, `Revoked token ${key.name}.`);
    },
  }),
];

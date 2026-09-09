import { arg, command, confirmFlag, flag } from "@k2b/cloud/cli";
import type { PulseBase } from "../contracts";
import { PULSE_BASE_DEFAULT_KEY, requireDefaultBaseRef, resolveBase, resolveBaseFromCommand } from "./context";
import { baseFlag } from "./flags";
import { baseRows } from "./rows";
import { jsonRequest, printJsonOrTable, printMessage, printStructured, readApi } from "./shared";
import type { MessageResult } from "./types";

export const baseCommands = [
  command("list", {
    summary: "List Pulse bases",
    async run({ ctx }) {
      const bases = await readApi<PulseBase[]>(ctx, "/bases");
      printJsonOrTable(ctx, bases, baseRows(bases), [
        { key: "id" },
        { key: "name" },
        { key: "rawRetentionDays", label: "raw" },
        { key: "rollupRetentionDays", label: "rollups" },
        { key: "sensitiveRetentionHours", label: "sensitive" },
        { key: "deletion" },
        { key: "updatedAt" },
      ]);
    },
  }),
  command("use", {
    summary: "Set the default Pulse base",
    args: { base: arg.required({ valueLabel: "base", description: "Base ID or exact name" }) },
    async run({ ctx, args }) {
      const base = await resolveBase(ctx, args.base);
      await ctx.setDefault(PULSE_BASE_DEFAULT_KEY, base.id);
      if (!printStructured(ctx, { base, defaultBase: base.id })) ctx.print(`Using Pulse base ${base.name} (${base.id}).`);
    },
  }),
  command("current", {
    summary: "Show the default Pulse base",
    async run({ ctx }) {
      const ref = await requireDefaultBaseRef(ctx);
      const base = await resolveBase(ctx, ref);
      if (!printStructured(ctx, { base, defaultBase: base.id })) ctx.print(`${base.name} (${base.id})`);
    },
  }),
  command("get", {
    summary: "Show a Pulse base",
    flags: baseFlag,
    args: { args: arg.rest({ valueLabel: "base" }) },
    async run({ ctx, args }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      if (!printStructured(ctx, base)) {
        ctx.print(`${base.name} (${base.id})`);
        ctx.print(`Raw retention: ${base.rawRetentionDays} days`);
        ctx.print(`Rollup retention: ${base.rollupRetentionDays} days`);
        ctx.print(`Sensitive retention: ${base.sensitiveRetentionHours} hours`);
        if (base.description) ctx.print(base.description);
      }
    },
  }),
  command("create", {
    summary: "Create a Pulse base",
    args: { name: arg.required({ valueLabel: "name" }) },
    flags: {
      description: flag.string({ description: "Base description" }),
      use: flag.boolean({ description: "Set the created base as default" }),
    },
    async run({ ctx, args, flags }) {
      const base = await readApi<PulseBase>(
        ctx,
        "/bases",
        jsonRequest("POST", { name: args.name, description: flags.description ?? null }),
      );
      if (flags.use) await ctx.setDefault(PULSE_BASE_DEFAULT_KEY, base.id);
      if (!printStructured(ctx, base)) ctx.print(`Created Pulse base ${base.name} (${base.id}).`);
    },
  }),
  command("update", {
    summary: "Update a Pulse base",
    flags: {
      ...baseFlag,
      name: flag.string({ description: "New base name" }),
      description: flag.string({ description: "New base description" }),
      rawRetentionDays: flag.int({ name: "raw-retention-days", min: 1, max: 3650, description: "Raw telemetry retention in days" }),
      rollupRetentionDays: flag.int({
        name: "rollup-retention-days",
        min: 1,
        max: 3650,
        description: "Hourly metric rollup retention in days",
      }),
      sensitiveRetentionHours: flag.int({
        name: "sensitive-retention-hours",
        min: 1,
        max: 8760,
        description: "Sensitive event field retention in hours",
      }),
    },
    args: { args: arg.rest({ valueLabel: "base" }) },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const patch = {
        name: flags.name,
        description: flags.description,
        rawRetentionDays: flags.rawRetentionDays,
        rollupRetentionDays: flags.rollupRetentionDays,
        sensitiveRetentionHours: flags.sensitiveRetentionHours,
      };
      const updated = await readApi<PulseBase>(ctx, `/bases/${encodeURIComponent(base.id)}`, jsonRequest("PATCH", patch));
      if (!printStructured(ctx, updated)) ctx.print(`Updated Pulse base ${updated.name} (${updated.id}).`);
    },
  }),
  command("delete", {
    summary: "Delete a Pulse base",
    flags: { ...baseFlag, yes: confirmFlag("Delete this Pulse base") },
    args: { args: arg.rest({ valueLabel: "base" }) },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Refusing to delete without --yes.");
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const result = await readApi<MessageResult>(ctx, `/bases/${encodeURIComponent(base.id)}`, jsonRequest("DELETE"));
      printMessage(ctx, result, result.message);
    },
  }),
  command("clear-data", {
    summary: "Clear all Pulse data while keeping the base and settings",
    flags: { ...baseFlag, yes: confirmFlag("Clear all data in this Pulse base") },
    args: { args: arg.rest({ valueLabel: "base" }) },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Refusing to clear data without --yes.");
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const result = await readApi<MessageResult>(ctx, `/bases/${encodeURIComponent(base.id)}/clear-data`, jsonRequest("POST"));
      printMessage(ctx, result, result.message);
    },
  }),
];

import {
  arg,
  type CloudCliContext,
  command,
  confirmFlag,
  defineCliCommands,
  flag,
  paginationFlags,
  printRows as printJsonOrTable,
  printStructured,
} from "@k2b/cloud/cli";
import type { IpaHost, IpaHostgroup, PaginationResponse, SyncCronResponse } from "./contracts";

type HostsResponse = {
  hosts: IpaHost[];
  pagination: PaginationResponse;
};

type HostgroupsResponse = {
  hostgroups: IpaHostgroup[];
  pagination: PaginationResponse;
};

type MessageResponse = {
  message: string;
};

const apiPath = (path = "") => `/api/ipa-hosts${path}`;

const apiGet = async <T>(ctx: CloudCliContext, path: string): Promise<T> => ctx.readJson<T>(await ctx.fetch(apiPath(path)));

const apiJson = async <T>(ctx: CloudCliContext, method: string, path: string, body?: unknown): Promise<T> =>
  ctx.readJson<T>(
    await ctx.fetch(apiPath(path), {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

const compact = <T extends Record<string, unknown>>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;

const queryString = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const value = search.toString();
  return value ? `?${value}` : "";
};

const pageQuery = (flags: { page?: number; perPage?: number }) => ({
  page: flags.page ?? 1,
  per_page: flags.perPage ?? 100,
});

const hostRows = (hosts: IpaHost[]) =>
  hosts.map((host) => ({
    fqdn: host.fqdn,
    hostgroups: host.memberofHostgroup.join(","),
    mac: host.macAddress.join(","),
    location: host.location ?? "",
    platform: host.platform ?? "",
  }));

const groupRows = (hostgroups: IpaHostgroup[]) =>
  hostgroups.map((group) => ({
    cn: group.cn,
    description: group.description ?? "",
    hosts: group.hosts.length,
    hostgroups: group.hostgroups.length,
  }));

const resolveHost = async (ctx: CloudCliContext, fqdn: string): Promise<IpaHost> => {
  let page = 1;
  for (;;) {
    const response = await apiGet<HostsResponse>(
      ctx,
      queryString({
        search: fqdn,
        page,
        per_page: 100,
      }),
    );
    const host = response.hosts.find((item) => item.fqdn === fqdn);
    if (host) return host;
    if (!response.pagination.has_next) break;
    page += 1;
  }
  throw new Error(`Host "${fqdn}" was not found.`);
};

const printMessage = (ctx: CloudCliContext, result: MessageResponse) => {
  if (!printStructured(ctx, result)) ctx.print(result.message);
};

export default defineCliCommands({
  name: "ipa-hosts",
  summary: "Manage IPA hosts and hostgroups.",
  groupSummaries: {
    groups: "Create, inspect, and manage IPA hostgroups",
    hosts: "Inspect and manage IPA hosts",
    sync: "Run and configure IPA host synchronization",
  },
  commands: [
    command("hosts list", {
      summary: "List IPA hosts",
      flags: {
        ...paginationFlags({ defaultPerPage: 100, maxPerPage: 100 }),
        search: flag.string({ description: "Filter by FQDN, hostgroup, platform, or metadata" }),
      },
      async run({ ctx, flags }) {
        const response = await apiGet<HostsResponse>(
          ctx,
          queryString({
            ...pageQuery(flags),
            search: flags.search,
          }),
        );
        printJsonOrTable(ctx, response, hostRows(response.hosts), [
          { key: "fqdn" },
          { key: "hostgroups" },
          { key: "mac", label: "MAC" },
          { key: "location" },
          { key: "platform" },
        ]);
      },
    }),
    command("hosts get", {
      summary: "Show an IPA host",
      args: { fqdn: arg.required({ valueLabel: "fqdn" }) },
      async run({ ctx, args }) {
        const host = await resolveHost(ctx, args.fqdn);
        if (!printStructured(ctx, host)) ctx.print(JSON.stringify(host, null, 2));
      },
    }),
    command("hosts update", {
      summary: "Update host metadata",
      args: { fqdn: arg.required({ valueLabel: "fqdn" }) },
      flags: {
        description: flag.string(),
        location: flag.string(),
        locality: flag.string(),
        macAddress: flag.stringList({ name: "mac-address", description: "MAC address. Repeat or comma-separate." }),
      },
      async run({ ctx, args, flags }) {
        const input = compact({
          description: flags.description,
          location: flags.location,
          locality: flags.locality,
          macAddress: flags.macAddress.length > 0 ? flags.macAddress : undefined,
        });
        if (Object.keys(input).length === 0) throw new Error("Pass at least one host field to update.");
        const result = await apiJson<MessageResponse>(ctx, "PATCH", `/${encodeURIComponent(args.fqdn)}`, input);
        printMessage(ctx, result);
      },
    }),
    command("hosts delete", {
      summary: "Delete an IPA host",
      args: { fqdn: arg.required({ valueLabel: "fqdn" }) },
      flags: { yes: confirmFlag("Delete the IPA host") },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to delete without --yes.");
        const result = await apiJson<MessageResponse>(ctx, "DELETE", `/${encodeURIComponent(args.fqdn)}`);
        printMessage(ctx, result);
      },
    }),
    command("hosts add-group", {
      summary: "Add a host to a hostgroup",
      args: {
        fqdn: arg.required({ valueLabel: "fqdn" }),
        hostgroup: arg.required({ valueLabel: "hostgroup" }),
      },
      async run({ ctx, args }) {
        const result = await apiJson<MessageResponse>(ctx, "POST", `/${encodeURIComponent(args.fqdn)}/hostgroups`, {
          hostgroup: args.hostgroup,
        });
        printMessage(ctx, result);
      },
    }),
    command("hosts remove-group", {
      summary: "Remove a host from a hostgroup",
      args: {
        fqdn: arg.required({ valueLabel: "fqdn" }),
        hostgroup: arg.required({ valueLabel: "hostgroup" }),
      },
      flags: { yes: confirmFlag("Remove the host from the hostgroup") },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to remove a hostgroup membership without --yes.");
        const result = await apiJson<MessageResponse>(
          ctx,
          "DELETE",
          `/${encodeURIComponent(args.fqdn)}/hostgroups/${encodeURIComponent(args.hostgroup)}`,
        );
        printMessage(ctx, result);
      },
    }),
    command("groups list", {
      summary: "List hostgroups",
      flags: {
        ...paginationFlags({ defaultPerPage: 100, maxPerPage: 100 }),
        search: flag.string({ description: "Filter hostgroups" }),
      },
      async run({ ctx, flags }) {
        const response = await apiGet<HostgroupsResponse>(
          ctx,
          `/hostgroups${queryString({
            ...pageQuery(flags),
            search: flags.search,
          })}`,
        );
        printJsonOrTable(ctx, response, groupRows(response.hostgroups), [
          { key: "cn", label: "Name" },
          { key: "description" },
          { key: "hosts" },
          { key: "hostgroups" },
        ]);
      },
    }),
    command("groups search", {
      summary: "Search hostgroups",
      args: { query: arg.required({ valueLabel: "query" }) },
      flags: { exclude: flag.stringList({ description: "Group name to exclude. Repeat or comma-separate." }) },
      async run({ ctx, args, flags }) {
        const response = await apiGet<{ hostgroups: IpaHostgroup[] }>(
          ctx,
          `/hostgroups/search${queryString({
            q: args.query,
            exclude: flags.exclude.join(","),
          })}`,
        );
        printJsonOrTable(ctx, response, groupRows(response.hostgroups), [
          { key: "cn", label: "Name" },
          { key: "description" },
          { key: "hosts" },
          { key: "hostgroups" },
        ]);
      },
    }),
    command("groups create", {
      summary: "Create a hostgroup",
      flags: {
        name: flag.string({ required: true }),
        description: flag.string(),
      },
      async run({ ctx, flags }) {
        const result = await apiJson<MessageResponse>(ctx, "POST", "/hostgroups", {
          name: flags.name,
          description: flags.description,
        });
        printMessage(ctx, result);
      },
    }),
    command("groups update", {
      summary: "Update a hostgroup",
      args: { cn: arg.required({ valueLabel: "hostgroup" }) },
      flags: { description: flag.string({ required: true }) },
      async run({ ctx, args, flags }) {
        const result = await apiJson<MessageResponse>(ctx, "PATCH", `/hostgroups/${encodeURIComponent(args.cn)}`, {
          description: flags.description,
        });
        printMessage(ctx, result);
      },
    }),
    command("groups delete", {
      summary: "Delete a hostgroup",
      args: { cn: arg.required({ valueLabel: "hostgroup" }) },
      flags: { yes: confirmFlag("Delete the hostgroup") },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to delete without --yes.");
        const result = await apiJson<MessageResponse>(ctx, "DELETE", `/hostgroups/${encodeURIComponent(args.cn)}`);
        printMessage(ctx, result);
      },
    }),
    command("sync status", {
      summary: "Show the host sync schedule",
      async run({ ctx }) {
        const sync = await apiGet<SyncCronResponse>(ctx, "/settings/sync-cron");
        if (!printStructured(ctx, sync)) ctx.table([sync], [{ key: "cron" }, { key: "timezone" }]);
      },
    }),
    command("sync schedule", {
      summary: "Update the host sync schedule",
      flags: { cron: flag.string({ required: true, description: "Cron expression" }) },
      async run({ ctx, flags }) {
        const result = await apiJson<MessageResponse>(ctx, "PUT", "/settings/sync-cron", { cron: flags.cron });
        printMessage(ctx, result);
      },
    }),
    command("sync run", {
      summary: "Trigger a host sync",
      flags: { yes: confirmFlag("Trigger host synchronization") },
      async run({ ctx, flags }) {
        if (!flags.yes) throw new Error("Refusing to trigger sync without --yes.");
        const result = await apiJson<MessageResponse>(ctx, "POST", "/sync");
        printMessage(ctx, result);
      },
    }),
  ],
});

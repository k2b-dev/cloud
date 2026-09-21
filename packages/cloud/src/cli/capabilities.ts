import { z } from "zod";
import { readBoundedJson } from "../_internal/bounded-json";
import {
  CAPABILITY_FRAMEWORK_ERROR_CODES,
  CAPABILITY_MAX_CATALOG_BYTES,
  CAPABILITY_MAX_RESULT_BYTES,
  CapabilityCatalogSchema,
  CapabilityErrorSchema,
  CapabilityStreamSchema,
  CloudResourceRefSchema,
  capabilityResultSchema,
  cloudResourceRefAppId,
  resolveCapabilityResourceReader,
} from "../contracts/capabilities";
import { saveCapabilityStream } from "./capability-streams";
import { arg, type CliInputFlagValue, type CloudCliContext, command, defineCliCommands, flag, readCliInput } from "./index";

const parseInput = async (input: CliInputFlagValue): Promise<unknown> => {
  const raw = await readCliInput(input, {
    label: "capability JSON input",
    required: true,
  });
  try {
    return JSON.parse(raw ?? "") as unknown;
  } catch {
    throw new Error("Capability input must be valid JSON.");
  }
};

const printGenericResult = (ctx: CloudCliContext, value: unknown): void => {
  if (ctx.options.output === "json") ctx.json(value);
  else if (ctx.options.output === "jsonl") ctx.jsonLine(value);
  else ctx.print(JSON.stringify(value, null, 2));
};

class CapabilityCliResponseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CapabilityCliResponseError";
  }
}

const readCapabilityJson = async (response: Response, maxBytes: number): Promise<unknown> => {
  const parsed = await readBoundedJson(response, maxBytes);
  if (!parsed.ok) {
    const code =
      parsed.reason === "too_large"
        ? CAPABILITY_FRAMEWORK_ERROR_CODES.responseTooLarge
        : CAPABILITY_FRAMEWORK_ERROR_CODES.invalidAppResponse;
    throw new CapabilityCliResponseError(code, `${code}: Cloud returned invalid or oversized capability JSON.`);
  }
  if (!response.ok) {
    const error = CapabilityErrorSchema.safeParse(parsed.data);
    if (error.success) {
      throw new CapabilityCliResponseError(error.data.code, `${response.status} ${error.data.code}: ${error.data.message}`);
    }
    throw new CapabilityCliResponseError(
      CAPABILITY_FRAMEWORK_ERROR_CODES.invalidAppResponse,
      `${response.status} ${CAPABILITY_FRAMEWORK_ERROR_CODES.invalidAppResponse}: Cloud returned an invalid capability error.`,
    );
  }
  return parsed.data;
};

const invoke = async (config: {
  ctx: CloudCliContext;
  kind: "queries" | "actions";
  appId: string;
  capabilityId: string;
  input?: CliInputFlagValue;
  inputValue?: unknown;
  idempotencyKey?: string;
}) => {
  const headers = new Headers({ "content-type": "application/json" });
  if (config.idempotencyKey) headers.set("idempotency-key", config.idempotencyKey);
  let response: Response;
  try {
    response = await config.ctx.fetch(
      `/api/capabilities/v1/${config.kind}/${encodeURIComponent(config.appId)}/${encodeURIComponent(config.capabilityId)}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ input: config.inputValue ?? (await parseInput(config.input!)) }),
      },
    );
  } catch (error) {
    if (config.kind === "actions" && !config.idempotencyKey) {
      throw new Error(
        `${CAPABILITY_FRAMEWORK_ERROR_CODES.actionOutcomeUnknown}: The Action response was lost and its outcome is unknown; do not retry automatically.`,
        { cause: error },
      );
    }
    throw error;
  }
  let body: unknown;
  try {
    body = await readCapabilityJson(response, CAPABILITY_MAX_RESULT_BYTES);
  } catch (error) {
    if (
      config.kind === "actions" &&
      !config.idempotencyKey &&
      error instanceof CapabilityCliResponseError &&
      (error.code === CAPABILITY_FRAMEWORK_ERROR_CODES.invalidAppResponse ||
        error.code === CAPABILITY_FRAMEWORK_ERROR_CODES.responseTooLarge)
    ) {
      throw new Error(
        `${CAPABILITY_FRAMEWORK_ERROR_CODES.actionOutcomeUnknown}: The Action response was lost and its outcome is unknown; do not retry automatically.`,
        { cause: error },
      );
    }
    throw error;
  }
  printGenericResult(config.ctx, capabilityResultSchema(z.unknown()).parse(body));
};

export default defineCliCommands({
  name: "capabilities",
  summary: "Discover and invoke versioned Cloud app capabilities.",
  commands: [
    ...(["read", "write", "status", "abort"] as const).map((verb) =>
      command(`stream-${verb}`, {
        summary: `${verb} an authenticated binary capability stream`,
        flags: {
          input: flag.input({ required: true, description: "Stream descriptor JSON; use --input-file or --stdin" }),
          ...(verb === "read" ? { out: flag.string({ required: true, description: "New output file; never overwritten" }) } : {}),
          ...(verb === "write" ? { file: flag.string({ required: true, description: "Local binary file to upload" }) } : {}),
        },
        run: async ({ ctx, flags }) => {
          const stream = CapabilityStreamSchema.parse(await parseInput(flags.input));
          if ((verb === "read") !== (stream.direction === "read")) throw new Error("Wrong stream direction.");
          const body = verb === "write" ? Bun.file(String(flags.file)) : undefined;
          if (body && (!(await body.exists()) || body.size !== stream.size))
            throw new Error("Input file must match the authorized byte size.");
          const controller = new AbortController();
          const abort = () => controller.abort();
          process.once("SIGINT", abort);
          process.once("SIGTERM", abort);
          try {
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]);
            const response = await ctx.fetch(`/api/capabilities/v1/streams/${verb}`, {
              method: "POST",
              headers: { "x-cloud-stream-id": stream.id, "content-type": "application/octet-stream" },
              body,
              signal,
              redirect: "error",
            });
            printGenericResult(
              ctx,
              verb === "read"
                ? await saveCapabilityStream(response, stream, String(flags.out), signal)
                : await readCapabilityJson(response, CAPABILITY_MAX_RESULT_BYTES),
            );
          } finally {
            process.off("SIGINT", abort);
            process.off("SIGTERM", abort);
          }
        },
      }),
    ),
    command("catalog", {
      summary: "List live capability manifests",
      flags: {
        cursor: flag.string({ description: "Continue after this app id" }),
        limit: flag.int({
          default: 10,
          min: 1,
          max: 25,
          description: "Maximum live apps to return",
        }),
      },
      run: async ({ ctx, flags }) => {
        const query = new URLSearchParams({ limit: String(flags.limit ?? 10) });
        if (flags.cursor) query.set("cursor", flags.cursor);
        const result = CapabilityCatalogSchema.parse(
          await readCapabilityJson(await ctx.fetch(`/api/capabilities/v1/catalog?${query}`), CAPABILITY_MAX_CATALOG_BYTES),
        );
        if (ctx.options.output === "json" || ctx.options.output === "jsonl") {
          printGenericResult(ctx, result);
          return;
        }
        ctx.table(
          result.apps.map((app) => ({
            app: app.appId,
            name: app.appName,
            types: app.manifest.types.length,
            queries: app.manifest.queries.length,
            actions: app.manifest.actions.length,
          })),
          [
            { key: "app", label: "APP" },
            { key: "name", label: "NAME" },
            { key: "types", label: "TYPES" },
            { key: "queries", label: "QUERIES" },
            { key: "actions", label: "ACTIONS" },
          ],
        );
        if (result.page.hasMore) ctx.error(`More apps available; continue with --cursor ${result.page.nextCursor}`);
      },
    }),
    command("query", {
      summary: "Invoke a read-only app query",
      args: {
        appId: arg.required({ description: "Owning app id" }),
        queryId: arg.required({ description: "App-local query id" }),
      },
      flags: {
        input: flag.input({
          required: true,
          description: "Strict JSON input; supports --input-file or --stdin",
        }),
      },
      run: ({ ctx, args, flags }) =>
        invoke({
          ctx,
          kind: "queries",
          appId: args.appId,
          capabilityId: args.queryId,
          input: flags.input,
        }),
    }),
    command("read", {
      summary: "Read a Cloud resource through its canonical capability reader",
      args: {
        type: arg.required({ description: "Qualified resource type" }),
        id: arg.required({ description: "Stable resource id" }),
      },
      run: async ({ ctx, args }) => {
        const ref = CloudResourceRefSchema.parse({ type: args.type, id: args.id });
        const appId = cloudResourceRefAppId(ref);
        let cursor: string | undefined;
        const seenCursors = new Set<string>();
        let app: z.infer<typeof CapabilityCatalogSchema>["apps"][number] | undefined;
        do {
          const query = new URLSearchParams({ limit: "25" });
          if (cursor) query.set("cursor", cursor);
          const page = CapabilityCatalogSchema.parse(
            await readCapabilityJson(await ctx.fetch(`/api/capabilities/v1/catalog?${query}`), CAPABILITY_MAX_CATALOG_BYTES),
          );
          app = page.apps.find((candidate) => candidate.appId === appId);
          const nextCursor = page.page.hasMore ? page.page.nextCursor : undefined;
          if (nextCursor && seenCursors.has(nextCursor)) throw new Error("Capability catalog returned a repeated cursor.");
          if (nextCursor) seenCursors.add(nextCursor);
          cursor = nextCursor;
        } while (!app && cursor);
        if (!app) throw new Error(`Capability app ${appId} is unavailable.`);
        const reader = resolveCapabilityResourceReader(app.manifest, ref);
        if (!reader) throw new Error(`Cloud resource type ${ref.type} is unknown or has no reader.`);
        await invoke({ ctx, kind: "queries", appId, capabilityId: reader.localId, inputValue: { id: ref.id } });
      },
    }),
    command("action", {
      summary: "Invoke an app mutation",
      args: {
        appId: arg.required({ description: "Owning app id" }),
        actionId: arg.required({ description: "App-local action id" }),
      },
      flags: {
        input: flag.input({
          required: true,
          description: "Strict JSON input; supports --input-file or --stdin",
        }),
        idempotencyKey: flag.string({
          name: "idempotency-key",
          description: "Stable retry key for an Action whose manifest requires idempotency",
        }),
      },
      run: ({ ctx, args, flags }) =>
        invoke({
          ctx,
          kind: "actions",
          appId: args.appId,
          capabilityId: args.actionId,
          input: flags.input,
          idempotencyKey: flags.idempotencyKey,
        }),
    }),
  ],
});

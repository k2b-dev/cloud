import { createHash } from "node:crypto";
import { chmod, chown, link, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { appKeyFingerprint, deriveAppPublicKey, formatAppKey, generateAppKeyPair, validateAppKeyAppId } from "../../app-key";
import { arg, command, confirmFlag, flag, printStructured } from "../index";
import { apiGet, apiJson } from "./shared";

const keyPath = (appId: string) => `/api/admin/apps/${encodeURIComponent(appId)}/keys`;
const registrationSchema = z.object({
  keyId: z.uuid(),
  installationId: z.uuid(),
  fingerprint: z.string().regex(/^[0-9a-f]{32}$/),
  status: z.enum(["active", "expired", "revoked"]),
  accountStatus: z.enum(["active", "disabled"]),
});
const enrollmentSchema = z
  .object({ version: z.literal(1), server: z.string(), appId: z.string(), seed: z.string(), publicKey: z.string() })
  .strict();
export type AppKeyArtifactFormat = "file" | "env" | "compose" | "k8s-secret";

export const renderAppKeyArtifact = (
  appId: string,
  privateKey: string,
  format: AppKeyArtifactFormat,
  keyFile = `./secrets/${appId}.key`,
): string => {
  validateAppKeyAppId(appId);
  if (format === "file") return `${privateKey}\n`;
  if (format === "env") return `CLOUD_APP_KEY=${privateKey}\n`;
  if (format === "compose")
    return `services:\n  app-${appId}:\n    environment:\n      CLOUD_APP_KEY_FILE: /run/secrets/${appId}.key\n      CLOUD_CORE_INTERNAL_ORIGIN: http://app-core:3000\n    secrets:\n      - source: ${appId}-app-key\n        target: ${appId}.key\nsecrets:\n  ${appId}-app-key:\n    file: ${JSON.stringify(keyFile)}\n`;
  const secretName =
    appId.length <= 50
      ? `${appId}-app-key`
      : `${appId.slice(0, 40)}-${createHash("sha256").update(appId).digest("hex").slice(0, 8)}-app-key`;
  return `apiVersion: v1\nkind: Secret\nmetadata:\n  name: ${secretName}\ntype: Opaque\nstringData:\n  app.key: ${JSON.stringify(privateKey)}\n`;
};

const isCode = (error: unknown, code: string): boolean => error instanceof Error && "code" in error && error.code === code;
const owner = async (path: string, uid?: number) => {
  await chmod(path, 0o600);
  if (uid !== undefined) await chown(path, uid, -1);
};

/** Publish the fully written, fsynced artifact atomically. Exclusive publication
 * elects the same provisional key even when two CLI processes start together. */
const atomicWrite = async (path: string, value: string, options: { exclusive?: boolean; uid?: number } = {}): Promise<boolean> => {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
    await owner(temporary, options.uid);
    await handle.close();
    let published = true;
    if (options.exclusive) {
      try {
        await link(temporary, path);
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
        published = false;
      }
    } else await rename(temporary, path);
    const directory = await open(resolve(path, ".."), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return published;
  } finally {
    await handle.close();
    await unlink(temporary).catch((error: unknown) => {
      if (!isCode(error, "ENOENT")) throw error;
    });
  }
};

export const enrollAppKey = async (input: {
  appId: string;
  server: string;
  outDir: string;
  format: AppKeyArtifactFormat;
  uid?: number;
  name?: string;
  grants?: "oauth:issue"[];
  register: (body: { publicKey: string; name?: string; grants?: "oauth:issue"[] }) => Promise<unknown>;
}) => {
  validateAppKeyAppId(input.appId);
  if (input.uid !== undefined && process.getuid?.() !== 0 && process.getuid?.() !== input.uid)
    throw new Error("--uid requires root or the current user ID");
  const outDir = resolve(input.outDir);
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const provisional = join(outDir, `.${input.appId}.enrollment.json`);
  const extension = { file: "key", env: "env", compose: "compose.yaml", "k8s-secret": "secret.yaml" }[input.format];
  const file = join(outDir, `${input.appId}.${extension}`);
  const server = input.server.replace(/\/$/, "");
  let state: z.infer<typeof enrollmentSchema>;
  try {
    state = enrollmentSchema.parse(JSON.parse(await readFile(provisional, "utf8")));
  } catch (error) {
    if (!isCode(error, "ENOENT"))
      throw new Error(`Cannot read enrollment state for ${input.appId}; preserve it and repair the file before retrying`);
    for (const path of input.format === "compose" ? [file, join(outDir, `${input.appId}.key`)] : [file]) {
      try {
        await lstat(path);
        throw new Error("Output already exists without an enrollment record; preserve it and use a new output directory");
      } catch (error) {
        if (!isCode(error, "ENOENT")) throw error;
      }
    }
    const pair = await generateAppKeyPair();
    await atomicWrite(provisional, JSON.stringify({ version: 1, server, appId: input.appId, ...pair }), {
      exclusive: true,
      uid: input.uid,
    });
    state = enrollmentSchema.parse(JSON.parse(await readFile(provisional, "utf8")));
  }
  if (state.server !== server || state.appId !== input.appId)
    throw new Error("Enrollment belongs to a different server or app; use another output directory");
  if ((await deriveAppPublicKey(state.seed)) !== state.publicKey) throw new Error("Enrollment public key does not match its seed");
  await owner(provisional, input.uid);
  const registered = registrationSchema.parse(
    await input.register({
      publicKey: state.publicKey,
      ...(input.name ? { name: input.name } : {}),
      ...(input.grants ? { grants: input.grants } : {}),
    }),
  );
  if (registered.fingerprint !== (await appKeyFingerprint(state.publicKey)))
    throw new Error("Core returned a different app-key fingerprint");
  if (registered.status !== "active")
    throw new Error(`The enrolled key is ${registered.status}; use a new output directory to generate a replacement key`);
  if (registered.accountStatus !== "active") throw new Error("The app service account is disabled; enable it before using this key");
  const privateKey = formatAppKey({
    appId: input.appId,
    installationId: registered.installationId,
    keyId: registered.keyId,
    seed: state.seed,
  });
  const keyFile = input.format === "compose" ? join(outDir, `${input.appId}.key`) : undefined;
  if (keyFile) await atomicWrite(keyFile, `${privateKey}\n`, { uid: input.uid });
  await atomicWrite(file, renderAppKeyArtifact(input.appId, privateKey, input.format, keyFile), { uid: input.uid });
  // Retain the provisional seed for safe repeats after any lost API/file response.
  // A rotation uses a new directory; repeating create never silently rotates.
  return {
    appId: input.appId,
    ...registered,
    file,
    ...(keyFile ? { keyFile } : {}),
    ...(input.format === "file" ? { environment: { CLOUD_APP_KEY_FILE: file } } : {}),
  };
};

export const resolveAppKeyApps = async (positional: string[], all: boolean, apps?: string): Promise<string[]> => {
  if (all && (positional.length > 0 || !apps)) throw new Error("--all requires --apps <comma-separated-list|file> and no positional apps");
  if (!all && apps) throw new Error("--apps requires --all");
  let selected = positional;
  if (all && apps) {
    let raw: string;
    try {
      raw = await readFile(apps, "utf8");
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
      raw = apps;
    }
    selected = raw.split(/[\s,]+/).filter(Boolean);
  }
  if (selected.length === 0) throw new Error("Name at least one app or use --all --apps <list|file>");
  return [...new Set(selected.map(validateAppKeyAppId))];
};

export const appKeyCommands = [
  command("apps keys create", {
    summary: "Generate app keys locally and resume enrollment into owner-only files",
    args: { apps: arg.rest({ valueLabel: "app" }) },
    flags: {
      all: flag.boolean({ description: "Enroll the explicit --apps list" }),
      apps: flag.string({ description: "Comma/space-separated app IDs or a file containing that list" }),
      outDir: flag.string({ required: true, description: "Directory for secret artifacts and resumable enrollment state" }),
      format: flag.enum(["file", "env", "compose", "k8s-secret"] as const, { default: "file" }),
      uid: flag.int({ min: 0, description: "File owner UID; requires root or the current UID" }),
      name: flag.string({ description: "Human-readable key name" }),
      grant: flag.enum(["oauth:issue"] as const, { description: "Grant OAuth issuance to each new key; repeat on rotation" }),
      noGrant: flag.boolean({ name: "no-grant", description: "Enroll new keys without grants (the default)" }),
    },
    async run({ ctx, args, flags }) {
      if (flags.grant && flags.noGrant) throw new Error("Choose either --grant or --no-grant");
      const apps = await resolveAppKeyApps(args.apps, flags.all, flags.apps);
      const results = [];
      for (const appId of apps)
        results.push(
          await enrollAppKey({
            appId,
            server: ctx.options.server,
            outDir: flags.outDir!,
            format: flags.format ?? "file",
            uid: flags.uid,
            name: flags.name,
            grants: flags.grant ? [flags.grant] : flags.noGrant ? [] : undefined,
            register: (body) => apiJson(ctx, "POST", keyPath(appId), body),
          }),
        );
      if (!printStructured(ctx, results))
        ctx.table(results, [
          { key: "appId", label: "App" },
          { key: "keyId", label: "Key ID" },
          { key: "file", label: "File" },
        ]);
    },
  }),
  command("apps keys list", {
    summary: "List one app's public keys and lifecycle metadata",
    args: { app: arg.required({ valueLabel: "app" }) },
    flags: { page: flag.int({ min: 1, default: 1 }), perPage: flag.int({ min: 1, max: 500, default: 100 }) },
    async run({ ctx, args, flags }) {
      validateAppKeyAppId(args.app);
      const result = z
        .object({
          installationId: z.uuid(),
          lastRejectedStart: z
            .object({
              at: z.iso.datetime(),
              reason: z.enum(["revoked", "expired", "disabled", "connections_not_permitted"]),
              keyId: z.uuid().nullable(),
            })
            .nullable()
            .optional(),
          items: z.array(
            z
              .object({
                keyId: z.string(),
                name: z.string(),
                fingerprint: z.string(),
                status: z.string(),
                accountStatus: z.string(),
                usable: z.boolean().optional(),
              })
              .passthrough(),
          ),
        })
        .passthrough()
        .parse(await apiGet(ctx, `${keyPath(args.app)}?page=${flags.page}&perPage=${flags.perPage}`));
      if (!printStructured(ctx, result)) {
        if (result.lastRejectedStart) {
          const rejection = result.lastRejectedStart;
          ctx.print(`Last rejected start: ${rejection.at} · ${rejection.reason} · key ${rejection.keyId ?? "unknown"}`);
        }
        ctx.table(result.items.map((item) => ({ ...item, usable: item.usable ?? "unknown" })), [
          { key: "keyId", label: "Key ID" },
          { key: "name", label: "Name" },
          { key: "fingerprint", label: "Fingerprint" },
          { key: "status", label: "Status" },
          { key: "accountStatus", label: "Account" },
          { key: "usable", label: "Usable" },
        ]);
      }
    },
  }),
  command("apps keys revoke", {
    summary: "Revoke one app key idempotently",
    args: { app: arg.required({ valueLabel: "app" }), keyId: arg.required({ valueLabel: "keyId" }) },
    flags: { yes: confirmFlag("Revoke this app key") },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Revoking an app key requires --yes");
      validateAppKeyAppId(args.app);
      const result = await apiJson(ctx, "DELETE", `${keyPath(args.app)}/${z.uuid().parse(args.keyId)}`);
      if (!printStructured(ctx, result)) ctx.print("App key revoked.");
    },
  }),
];

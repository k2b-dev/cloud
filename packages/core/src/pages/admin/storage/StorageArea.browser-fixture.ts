/** Synthetic buckets and a synthetic Core API; the real AdminLayout, Storage view, islands and styles. No live services. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import {
  type AdminStorageBucket,
  DEFAULT_STORAGE_BUCKET_ID,
  StorageBucketCreateSchema,
  StorageBucketIdSchema,
  StorageBucketRestoreSchema,
  StorageBucketUpdateSchema,
  type StorageBucketUsage,
} from "@k2b/cloud/contracts/storage-buckets";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import type { SettingFieldDef } from "../settings/_components/setting-field";
import type { StorageSelection } from "./view";

const lea = { id: "11111111-1111-4111-8111-111111111111", name: "Lea Schulz" };
const mara = { id: "22222222-2222-4222-8222-222222222222", name: "Mara Beispiel" };
const user: User = {
  id: lea.id,
  uid: "lea.schulz",
  roles: ["admin", "user", "local", "local/user"],
  provider: "local",
  profile: "user",
  givenname: "Lea",
  sn: "Schulz",
  displayName: "Lea Schulz",
  mail: "lea.schulz@example.test",
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
};

export const STORAGE_FIXTURE_IDS = {
  archive: "3f0c2a54-8f1e-4c3b-9a0d-6b1e2c3d4e5f",
  media: "5a7b9c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d",
  customer: "7c8d9e0f-1a2b-4c3d-9e4f-5a6b7c8d9e0f",
  backup: "9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b",
  created: "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
} as const;

const tested = "2026-11-10T08:42:00.000Z";
const bucket = (patch: Partial<AdminStorageBucket> & Pick<AdminStorageBucket, "id" | "name" | "bucket">): AdminStorageBucket => ({
  isDefault: false,
  access: "own",
  endpoint: null,
  region: null,
  hasCredentials: true,
  removedAt: null,
  check: { state: "ok", step: null, checkedAt: tested },
  revision: 3,
  updatedAt: "2026-11-09T15:00:00.000Z",
  updatedBy: lea,
  ...patch,
});

const defaultBucket = (): AdminStorageBucket =>
  bucket({
    id: DEFAULT_STORAGE_BUCKET_ID,
    name: "Default",
    isDefault: true,
    endpoint: "https://s3.beispiel.org",
    region: "garage",
    bucket: "cloud-objekte",
    revision: null,
    check: { state: "ok", step: null, checkedAt: "2026-11-10T08:40:00.000Z" },
  });

const furtherBuckets = (): AdminStorageBucket[] => [
  bucket({
    id: StorageBucketIdSchema.parse(STORAGE_FIXTURE_IDS.archive),
    name: "Archiv",
    endpoint: "https://fsn1.objekt-anbieter.example",
    region: "fsn1",
    bucket: "cloud-archiv",
  }),
  bucket({
    id: StorageBucketIdSchema.parse(STORAGE_FIXTURE_IDS.media),
    name: "Medien",
    access: "inherit",
    hasCredentials: false,
    bucket: "cloud-medien",
  }),
  bucket({
    id: StorageBucketIdSchema.parse(STORAGE_FIXTURE_IDS.customer),
    name: "Kunde Hofmann",
    endpoint: "https://s3.hofmann-gmbh.example",
    region: "eu-central-1",
    bucket: "cloud-ablage",
    check: { state: "failed", step: "write", checkedAt: tested },
  }),
  bucket({
    id: StorageBucketIdSchema.parse(STORAGE_FIXTURE_IDS.backup),
    name: "Backup",
    endpoint: "https://s3.beispiel.org",
    region: "garage",
    bucket: "cloud-backup",
    hasCredentials: false,
    removedAt: "2026-11-03T10:00:00.000Z",
  }),
];

const defaultEntries = (): SettingFieldDef[] => {
  const entry = (
    key: string,
    label: string,
    kind: SettingFieldDef["kind"],
    value: unknown,
    extra: Partial<SettingFieldDef> = {},
  ): SettingFieldDef => ({
    key,
    label,
    description: "",
    kind,
    value,
    default: kind === "number" ? 33554432 : "",
    resetValue: kind === "number" ? 33554432 : "",
    valueSource: "custom",
    resetValueSource: "default",
    isCustom: true,
    unreadable: false,
    group: "storage",
    updatedAt: "2026-11-01T09:00:00.000Z",
    updatedBy: lea,
    ...extra,
  });
  return [
    entry("storage.endpoint", "Garage S3 endpoint", "url", "https://s3.beispiel.org"),
    entry("storage.region", "Signing region", "string", "garage"),
    entry("storage.bucket", "Bucket", "string", "cloud-objekte"),
    entry("storage.access_key_id", "Access key ID", "secret", ""),
    entry("storage.secret_access_key", "Secret access key", "secret", ""),
    entry("storage.max_object_bytes", "Maximum object size (bytes)", "number", 33554432, { min: 1 }),
    entry("previews.max_bytes", "Preview storage budget (bytes)", "number", 2147483648, {
      min: 0,
      group: "previews",
      default: 2147483648,
      resetValue: 2147483648,
    }),
  ];
};

/** Named starting points; transient states (saving, conflict, failed test, removing) are reached by interaction. */
export const STORAGE_SCENARIOS = {
  liste: () => [defaultBucket(), ...furtherBuckets()],
  leer: () => [defaultBucket()],
  fehler: () => null,
} satisfies Record<string, () => AdminStorageBucket[] | null>;
export type StorageScenario = keyof typeof STORAGE_SCENARIOS;

const USAGE: Record<string, StorageBucketUsage> = {
  default: { packages: ["rechnungen", "venue", "warenfluss"], truncated: false },
  [STORAGE_FIXTURE_IDS.archive]: { packages: ["rechnungen", "warenfluss"], truncated: false },
  [STORAGE_FIXTURE_IDS.media]: { packages: ["venue"], truncated: true },
};

export async function storageAreaBrowserFixture(options: { port?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "core-storage-host-"));
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
  const { renderToString } = await import("solid-js/web");
  const { createComponent } = await import("solid-js");
  const { StorageView } = await import("./view");
  const ui = resolve(import.meta.dir, "../../../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", `${ui}/`));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", `${ui}/`))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", `${ui}/`))).default;
  const bundle = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "StorageArea.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-storage-area-fixture",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const transformed = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: transformed.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not compile the storage area islands");
  const script = await bundle.outputs[0]!.text();
  const styles = await Promise.all(
    [resolve(import.meta.dir, "../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../styles.css")].map((entry) =>
      Bun.build({ entrypoints: [entry], plugins: [tailwind] }),
    ),
  );
  for (const build of styles) if (!build.success) throw new AggregateError(build.logs, "Could not compile page styles");
  const css = [
    "@layer properties, theme, base, components, utilities;",
    ...(await Promise.all(styles.map((build) => build.outputs[0]!.text()))),
  ].join("\n");
  const publicDir = join(root, "public");
  await (await import("../../../../scripts/font-assets")).buildFontAssets(publicDir);
  await (await import("../../../../scripts/tabler-assets")).buildTablerIconAssets(publicDir);

  // The synthetic Core keeps its buckets across navigations; `?state=` starts a scenario afresh.
  let items: AdminStorageBucket[] | null = STORAGE_SCENARIOS.liste();
  const control = {
    /** The next write answers a conflict with Mara's version. */
    conflictNext: false,
    /** Tests of these buckets fail while writing. */
    failingTests: new Set<string>(),
    failUsage: false,
    requests: [] as Array<{ method: string; path: string; body: string }>,
    items: () => items,
  };
  const find = (id: string) => items?.find((item) => item.id === id);
  const error = (code: string, message: string, status: 400 | 404 | 409 | 502, current?: AdminStorageBucket) =>
    Response.json({ code, message, ...(current ? { current } : {}) }, { status });
  const nameTaken = (name: string, id?: string) =>
    items?.some((item) => !item.isDefault && !item.removedAt && item.id !== id && item.name.toLowerCase() === name.trim().toLowerCase());
  const checked = (current: AdminStorageBucket): AdminStorageBucket => ({
    ...current,
    check:
      control.failingTests.has(current.id) || control.failingTests.has(current.name)
        ? { state: "failed", step: "write", checkedAt: "2026-11-10T12:00:00.000Z" }
        : { state: "ok", step: null, checkedAt: "2026-11-10T12:00:00.000Z" },
  });
  const replace = (next: AdminStorageBucket) => {
    items = (items ?? []).map((item) => (item.id === next.id ? next : item));
    return Response.json({ bucket: next });
  };

  const api = async (request: Request, path: string): Promise<Response> => {
    const body = request.method === "GET" || request.method === "DELETE" ? "" : await request.clone().text();
    control.requests.push({ method: request.method, path, body });
    if (!items) return error("storage_bucket_unreachable", "Synthetic outage", 502);
    if (request.method === "GET" && path === "/buckets") return Response.json({ items });
    if (request.method === "POST" && path === "/buckets") {
      const input = StorageBucketCreateSchema.parse(JSON.parse(body));
      if (nameTaken(input.name)) return error("storage_bucket_name_taken", "Name taken", 409);
      const created = checked(
        bucket({
          id: StorageBucketIdSchema.parse(STORAGE_FIXTURE_IDS.created),
          name: input.name,
          bucket: input.bucket,
          access: input.access,
          endpoint: input.access === "own" ? input.endpoint : null,
          region: input.access === "own" ? input.region : null,
          hasCredentials: input.access === "own",
          revision: 1,
        }),
      );
      items = [...items, created];
      return Response.json({ bucket: created }, { status: 201 });
    }
    const match = path.match(/^\/buckets\/([^/]+)(?:\/(test|restore|usage))?$/);
    const current = match ? find(match[1]!) : undefined;
    if (!match || !current) return error("storage_bucket_unknown", "Unknown bucket", 404);
    const action = match[2];
    if (request.method === "GET" && action === "usage") {
      if (control.failUsage || current.check.state === "failed") return error("storage_bucket_unreachable", "Unreachable", 502);
      return Response.json(USAGE[current.id] ?? { packages: [], truncated: false });
    }
    if (request.method === "POST" && action === "test") return replace(checked(current));
    if (request.method === "PUT" && !action) {
      const input = StorageBucketUpdateSchema.parse(JSON.parse(body));
      if (control.conflictNext) {
        control.conflictNext = false;
        const theirs = { ...current, name: `${current.name} (Mara)`, revision: (current.revision ?? 1) + 1, updatedBy: mara };
        replace(theirs);
        return error("storage_bucket_conflict", "Changed in the meantime", 409, theirs);
      }
      if (input.revision !== current.revision) return error("storage_bucket_conflict", "Changed in the meantime", 409, current);
      if (nameTaken(input.name, current.id)) return error("storage_bucket_name_taken", "Name taken", 409);
      return replace(
        checked({
          ...current,
          name: input.name,
          access: input.access,
          bucket: input.bucket,
          endpoint: input.access === "own" ? input.endpoint : null,
          region: input.access === "own" ? input.region : null,
          hasCredentials: input.access === "own" && (current.hasCredentials || Boolean(input.accessKeyId && input.secretAccessKey)),
          revision: (current.revision ?? 1) + 1,
        }),
      );
    }
    if (request.method === "DELETE" && !action)
      return replace({ ...current, removedAt: "2026-11-10T12:00:00.000Z", hasCredentials: false });
    if (request.method === "POST" && action === "restore") {
      const input = StorageBucketRestoreSchema.parse(JSON.parse(body || "{}"));
      if (current.access === "own" && !(input.accessKeyId && input.secretAccessKey))
        return error("storage_bucket_invalid", "Keys required", 400);
      if (nameTaken(current.name, current.id)) return error("storage_bucket_name_taken", "Name taken", 409);
      return replace(checked({ ...current, removedAt: null, hasCredentials: current.access === "own" }));
    }
    return error("storage_bucket_invalid", "Synthetic fixture: unsupported", 400);
  };

  const pages = new Hono<{
    Variables: {
      runtime: CloudRuntime;
      user: User;
      settings: Record<string, unknown>;
      actor: undefined;
      panelConsent: undefined;
      railPreferences: undefined;
      announcements: undefined;
      page: { title?: string; theme: "light" | "dark" };
    };
  }>();
  pages.get("/admin/storage", (c) => {
    const locale = c.req.query("locale") === "en" ? "en" : "de";
    const theme = c.req.query("theme") === "dark" ? "dark" : "light";
    const scenario = Object.entries(STORAGE_SCENARIOS).find(([name]) => name === c.req.query("state"));
    if (scenario) items = scenario[1]();
    c.req.raw.headers.set("x-cloud-locale", locale);
    c.set("runtime", { apps: [{ id: "core", name: "Core", description: "Platform", icon: "ti ti-cloud", routes: ["/admin", "/"] }] });
    c.set("user", user);
    c.set("settings", { app: { name: "Cloud", locale } });
    c.set("page", { title: locale === "de" ? "Speicher" : "Storage", theme });
    const requested = c.req.query("bucket");
    const found = requested ? items?.find((item) => item.id === requested) : undefined;
    const selection: StorageSelection =
      requested === undefined
        ? { kind: "none" }
        : requested === "new"
          ? { kind: "new" }
          : found
            ? { kind: "bucket", bucket: found }
            : { kind: "unknown" };
    const body = renderToString(() => createComponent(StorageView, { c, locale, items, selection, defaultEntries: defaultEntries() }));
    return c.html(
      `<!doctype html><html lang="${locale}" class="${theme}" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/public/fonts.css"><link rel="stylesheet" href="/public/tabler-icons.css"><style>${css}</style></head><body class="k2b-ui${theme === "dark" ? " k2b-dark" : ""}">${body}<script src="/fixture.js"></script></body></html>`,
    );
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/branding/logo")
        return new Response(Bun.file(resolve(import.meta.dir, "../../../../../cloud/public/logo.svg")));
      if (url.pathname === "/fixture.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
      if (url.pathname.startsWith("/public/")) {
        const path = resolve(root, `.${url.pathname}`);
        return path.startsWith(`${publicDir}/`) ? new Response(Bun.file(path)) : new Response(null, { status: 404 });
      }
      if (url.pathname.startsWith("/api/admin/core/storage")) return api(request, url.pathname.replace("/api/admin/core/storage", ""));
      if (url.pathname.startsWith("/api/")) return Response.json({ message: "Synthetic fixture: unavailable" }, { status: 503 });
      return pages.fetch(request);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/admin/storage`,
    control,
    close() {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

if (import.meta.main) {
  const fixture = await storageAreaBrowserFixture({ port: Number(Bun.argv[2] ?? 0) });
  console.log(fixture.url);
}

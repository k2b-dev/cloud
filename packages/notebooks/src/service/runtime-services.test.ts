import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import type { PermissionLevel, User } from "@valentinkolb/cloud/contracts";
import type { ServiceAccount } from "@valentinkolb/cloud/services";

const cloudServices = await import("@valentinkolb/cloud/services");
const cloud = await import("@valentinkolb/cloud");
const accessModule = await import("./access");
const noteRefsModule = await import("./note-refs");
const snapshotWorkerModule = await import("./yjs-snapshot-worker");

const existingServiceAccount: ServiceAccount = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Notebook API keys",
  kind: "resource_bound",
  status: "active",
  delegatedUserId: null,
  appId: "notebooks",
  resourceType: "notebook",
  resourceId: "22222222-2222-4222-8222-222222222222",
  createdBy: "33333333-3333-4333-8333-333333333333",
  createdAt: "2026-06-01T00:00:00.000Z",
};

const actor: User = {
  id: "33333333-3333-4333-8333-333333333333",
  uid: "admin",
  roles: ["admin"],
  provider: "local",
  profile: "user",
  givenname: "Ada",
  sn: "Admin",
  displayName: "Admin",
  mail: "admin@example.org",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};

type SubmittedJob = {
  key: string;
  input?: unknown;
};

type CreatedSchedule = {
  id: string;
  cron: string;
  timezone: string;
  process: (config: { runId: string; signal?: AbortSignal; heartbeat?: () => Promise<void> }) => Promise<void>;
};

let serviceAccountLookupCount = 0;
let serviceAccountCreateCount = 0;
let accessEnsures: unknown[] = [];
let tokenCreates: unknown[] = [];
let existingKeyPermission: Extract<PermissionLevel, "read" | "write" | "admin"> = "read";
let submittedJobs: SubmittedJob[] = [];
let createdSchedules: CreatedSchedule[] = [];
let schedulerStarts = 0;
let reindexRuns = 0;
let reconcileRuns = 0;
let jobHandler:
  | ((context: { input: { trigger: "scheduler" }; signal: AbortSignal; heartbeat: () => Promise<void> }) => Promise<void>)
  | undefined;
let workerStops = 0;
let workerDrains = 0;

mock.module("@valentinkolb/cloud/services", () => ({
  ...cloudServices,
  get: async (key: string) => {
    if (key === "app.timezone") return "Europe/Berlin";
    if (key === "notebooks.reindex_cron") return "0 */12 * * *";
    return null;
  },
  logger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
  serviceAccounts: {
    getByResource: async () => {
      serviceAccountLookupCount += 1;
      return existingServiceAccount;
    },
    createResourceBound: async () => {
      serviceAccountCreateCount += 1;
      return ok(existingServiceAccount);
    },
    delete: async () => ok(),
  },
  serviceAccountCredentials: {
    createResourceApiToken: async (config: unknown) => {
      tokenCreates.push(config);
      return ok({
        credential: {
          id: "44444444-4444-4444-8444-444444444444",
          serviceAccountId: existingServiceAccount.id,
          name: "embed",
          tokenPrefix: "cld_test",
          scopes: ["write"],
          expiresAt: null,
          lastUsedAt: null,
          createdAt: "2026-06-01T00:00:00.000Z",
          revokedAt: null,
        },
        token: "cld_test_secret",
      });
    },
    revoke: async () => ok({ message: "API key revoked." }),
    listOverview: async () => ({ items: [] }),
  },
}));

const fakeWorker = {
  stop: () => {
    workerStops += 1;
  },
  drain: async () => {
    workerDrains += 1;
  },
};
const fakeSync = {
  job: () => ({
    process: async (_options: unknown, handler: typeof jobHandler) => {
      jobHandler = handler;
      return fakeWorker;
    },
    submit: async (config: SubmittedJob) => {
      submittedJobs.push(config);
      return { jobId: `job:${config.key}` };
    },
  }),
  scheduler: () => ({
    process: async () => {
      schedulerStarts += 1;
      return fakeWorker;
    },
    create: async (config: CreatedSchedule) => {
      createdSchedules.push(config);
    },
  }),
};
mock.module("@valentinkolb/cloud", () => ({
  ...cloud,
  lazySync: (create: (sync: typeof fakeSync) => unknown) => {
    const handle = create(fakeSync);
    return () => handle;
  },
}));

mock.module("./access", () => ({
  ...accessModule,
  NOTEBOOKS_APP_ID: "notebooks",
  NOTEBOOK_RESOURCE_TYPE: "notebook",
  ensureNotebookServiceAccountAccess: async (config: unknown) => {
    accessEnsures.push(config);
    return ok({ permission: (config as { permission: string }).permission });
  },
  listNotebookApiKeys: async () => [
    {
      id: "55555555-5555-4555-8555-555555555555",
      serviceAccountId: existingServiceAccount.id,
      name: "existing",
      tokenPrefix: "cld_existing",
      scopes: [existingKeyPermission],
      permission: existingKeyPermission,
      expiresAt: null,
      lastUsedAt: null,
      createdAt: "2026-06-01T00:00:00.000Z",
      revokedAt: null,
    },
  ],
}));

mock.module("./note-refs", () => ({
  ...noteRefsModule,
  reindexAll: async () => {
    reindexRuns += 1;
    return { notebooks: 0, notes: 0, failed: 0 };
  },
}));

mock.module("./yjs-snapshot-worker", () => ({
  ...snapshotWorkerModule,
  yjsSnapshotWorker: {
    ...snapshotWorkerModule.yjsSnapshotWorker,
    reconcile: async () => {
      reconcileRuns += 1;
      return { checked: 0, queued: 0 };
    },
  },
}));

const apiKeys = await import("./api-keys");
const { reindexRuntime } = await import("./reindex-scheduler");

beforeEach(async () => {
  await reindexRuntime.stop();
  serviceAccountLookupCount = 0;
  serviceAccountCreateCount = 0;
  accessEnsures = [];
  tokenCreates = [];
  existingKeyPermission = "read";
  submittedJobs = [];
  createdSchedules = [];
  schedulerStarts = 0;
  reindexRuns = 0;
  reconcileRuns = 0;
  workerStops = 0;
  workerDrains = 0;
});

describe("notebook resource API keys", () => {
  test("reuses the existing resource service account instead of creating one per key", async () => {
    const created = await apiKeys.create({
      notebookId: existingServiceAccount.resourceId!,
      notebookName: "Notebook",
      actor,
      data: {
        name: "embed",
        permission: "write",
      },
    });

    expect(created.ok).toBe(true);
    expect(serviceAccountLookupCount).toBe(1);
    expect(serviceAccountCreateCount).toBe(0);
    expect(tokenCreates).toHaveLength(1);
    expect(tokenCreates[0]).toMatchObject({
      serviceAccountId: existingServiceAccount.id,
      name: "embed",
      scopes: ["write"],
    });
  });

  test("raises service account access to the strongest active key permission", async () => {
    existingKeyPermission = "admin";

    const created = await apiKeys.create({
      notebookId: existingServiceAccount.resourceId!,
      notebookName: "Notebook",
      actor,
      data: {
        name: "readonly",
        permission: "read",
      },
    });

    expect(created.ok).toBe(true);
    expect(accessEnsures).toHaveLength(1);
    expect(accessEnsures[0]).toMatchObject({
      notebookId: existingServiceAccount.resourceId,
      serviceAccountId: existingServiceAccount.id,
      permission: "admin",
    });
  });
});

describe("notebook reindex runtime", () => {
  test("submits scheduled reindex work without a startup backfill", async () => {
    await reindexRuntime.start();

    expect(schedulerStarts).toBe(1);
    expect(createdSchedules.map((schedule) => [schedule.id, schedule.cron, schedule.timezone])).toEqual([
      ["notebooks:yjs-snapshot-reconcile", "0 * * * *", "Europe/Berlin"],
      ["notebooks:reindex", "0 */12 * * *", "Europe/Berlin"],
    ]);
    expect(submittedJobs).toEqual([]);
    expect(reindexRuns).toBe(0);

    await createdSchedules[1]!.process({ runId: "run:12345" });

    expect(submittedJobs).toContainEqual({ key: "run:12345", input: { trigger: "scheduler" } });
    expect(reindexRuns).toBe(0);
  });

  test("runs the hourly snapshot reconcile inline on its schedule", async () => {
    await reindexRuntime.start();
    const reconcile = createdSchedules.find((schedule) => schedule.id === "notebooks:yjs-snapshot-reconcile")!;

    await reconcile.process({ runId: "run:reconcile", signal: new AbortController().signal, heartbeat: async () => {} });

    expect(reconcileRuns).toBe(1);
    expect(submittedJobs).toEqual([]);
  });
});

test("reindex runtime executes jobs and drains both workers before restart", async () => {
  await reindexRuntime.start();
  await jobHandler!({ input: { trigger: "scheduler" }, signal: new AbortController().signal, heartbeat: async () => {} });
  expect(reindexRuns).toBe(1);
  await reindexRuntime.stop();
  expect(workerStops).toBe(2);
  expect(workerDrains).toBe(2);
  await reindexRuntime.start();
  expect(schedulerStarts).toBe(2);
});

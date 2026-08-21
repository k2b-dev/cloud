import { describe, expect, test } from "bun:test";
import { type CloudCliContext, type CloudCliFlags, defineCliCommands } from "@valentinkolb/cloud/cli";
import { businessDocumentCommands } from "./business-documents";

const base = { id: "BASE12", name: "Bookshop" };
const businessDocument = {
  id: "DOC123",
  baseId: base.id,
  profileId: "test.statement",
  profileVersion: 1,
  source: { appId: "orders", resourceType: "order", resourceId: "42" },
  sourceRevision: { id: "7", observedAt: "2026-08-22T10:00:00.000Z", evidence: {} },
  snapshotSha256: "a".repeat(64),
  number: "STAT-0001",
  relationship: "original",
  predecessorId: null,
  rendererVersion: "renderer-v1",
  validatorVersion: "validator-v1",
  validationStatus: "valid",
  validationReport: {},
  issuedAt: "2026-08-22T10:00:00.000Z",
  artifacts: [],
};

const createContext = (args: string[], flags: CloudCliFlags, responses: Response[]) => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const lines: string[] = [];
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "test", server: "http://cloud.test", token: "token", output: "json" },
    getDefault: async () => undefined,
    setDefault: async () => undefined,
    createApiClient: (() => {
      throw new Error("not needed");
    }) as CloudCliContext["createApiClient"],
    fetch: async (path, init) => {
      calls.push({ path, init });
      const response = responses.shift();
      if (!response) throw new Error(`Unexpected fetch: ${path}`);
      return response;
    },
    readJson: async (response) => {
      const value = await response.json();
      if (!response.ok) throw new Error(response.statusText);
      return value;
    },
    print: (value = "") => lines.push(value),
    write: async (value) => void lines.push(value),
    error: (value) => lines.push(value),
    json: (value) => lines.push(JSON.stringify(value)),
    jsonLine: (value) => lines.push(JSON.stringify(value)),
    table: () => undefined,
  };
  return { ctx, calls, lines };
};

const cli = defineCliCommands({ name: "grids", summary: "test", commands: businessDocumentCommands });

describe("Business Document CLI", () => {
  test("sends native issuance to the public Base route without accepting a UUID resource reference", async () => {
    const body = {
      profileId: "test.statement",
      profileVersion: 1,
      idempotencyKey: "order-42",
      source: businessDocument.source,
      sourceRevision: businessDocument.sourceRevision,
      snapshot: { total: "10.00" },
      relationship: "original",
    };
    const { ctx, calls } = createContext(["business-documents", "issue", "Bookshop"], { body: JSON.stringify(body) }, [
      Response.json({ items: [base], total: 1, limit: 500, offset: 0 }),
      Response.json({ document: businessDocument, replayed: false }),
    ]);
    await cli.run(ctx);
    expect(calls[1]?.path).toBe("/api/grids/business-documents/by-base/BASE12/issue");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual(body);

    const invalid = createContext(["business-documents", "get", "019c8ddd-1111-7111-8111-111111111111"], {}, []);
    await expect(cli.run(invalid.ctx)).rejects.toThrow("must be a 6-character public id");
    expect(invalid.calls).toHaveLength(0);
  });

  test("exposes the native, GQL, inspection, and artifact commands", async () => {
    const { ctx, lines } = createContext(["business-documents"], { help: true }, []);
    await cli.run(ctx);
    const help = lines.join("\n");
    for (const name of ["profiles", "list", "issue", "issue-from-gql", "get", "download"]) expect(help).toContain(name);
  });
});

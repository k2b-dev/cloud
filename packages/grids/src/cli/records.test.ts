import { describe, expect, test } from "bun:test";
import { composeRecordExportBody, composeRecordListBody, recordCommands } from "./records";

describe("record CLI structured body precedence", () => {
  test("does not populate composable flags with parser defaults", () => {
    const list = recordCommands.find((command) => command.path.join(" ") === "records ls");
    const exportRecords = recordCommands.find((command) => command.path.join(" ") === "records export");
    const listLimit = list?.flags?.limit;
    const exportFormat = exportRecords?.flags?.format;

    expect(listLimit && "default" in listLimit ? listLimit.default : undefined).toBeUndefined();
    expect(exportFormat && "default" in exportFormat ? exportFormat.default : undefined).toBeUndefined();
  });

  test("preserves a query-body limit unless the limit flag is explicit", () => {
    expect(composeRecordListBody({ limit: 750, search: { q: "body" } }, {})).toEqual({
      query: { limit: 750, search: { q: "body" } },
      cursor: undefined,
    });
    expect(composeRecordListBody({ limit: 750 }, { limit: 25 })).toEqual({
      query: { limit: 25 },
      cursor: undefined,
    });
  });

  test("adds the list default only when body and flag omit the limit", () => {
    expect(composeRecordListBody({}, {})).toEqual({ query: { limit: 100 }, cursor: undefined });
  });

  test("adds a friendly Finalization state without replacing other metadata", () => {
    expect(
      composeRecordListBody(
        { recordMeta: { users: { createdBy: ["11111111-1111-4111-8111-111111111111"] } } },
        { finalization: "awaiting-review" },
      ),
    ).toEqual({
      query: {
        limit: 100,
        recordMeta: {
          users: { createdBy: ["11111111-1111-4111-8111-111111111111"] },
          finalizationStates: ["awaitingReview"],
        },
      },
      cursor: undefined,
    });
  });

  test("preserves export body format and nested settings without explicit flags", () => {
    expect(
      composeRecordExportBody({ format: "json", csv: { delimiter: ";", quote: "'" }, query: { limit: 500, includeDeleted: true } }, {}),
    ).toEqual({
      format: "json",
      csv: { delimiter: ";", quote: "'" },
      query: { limit: 500, includeDeleted: true },
    });
  });

  test("lets explicit export flags override only their fields", () => {
    expect(
      composeRecordExportBody(
        { format: "json", csv: { delimiter: ";", quote: "'" }, query: { limit: 500, includeDeleted: true } },
        { format: "csv", delimiter: "pipe", limit: 20 },
      ),
    ).toEqual({
      format: "csv",
      csv: { delimiter: "|", quote: "'" },
      query: { limit: 20, includeDeleted: true },
    });
  });

  test("adds the export default only when body and flag omit the format", () => {
    expect(composeRecordExportBody({}, {})).toEqual({ format: "csv" });
  });
});

describe("record file lifecycle commands", () => {
  test("exposes explicit atomic replace and honest remove wording", () => {
    const replace = recordCommands.find((command) => command.path.join(" ") === "records files replace");
    const remove = recordCommands.find((command) => command.path.join(" ") === "records files delete");

    expect(replace?.summary).toBe("Replace one record file attachment atomically");
    expect(replace?.flags).toHaveProperty("current");
    expect(replace?.flags).toHaveProperty("file");
    expect(remove?.summary).toBe("Remove one file attachment from the current record");
  });
});

test("snapshot human rows use creator names and localized missing-person labels while retaining resource IDs", async () => {
  const { snapshotRows } = await import("./records-support");
  const rows = snapshotRows(
    [
      {
        id: "snapshot",
        recordId: "record",
        tableId: "table",
        createdBy: "11111111-1111-4111-8111-111111111111",
        createdAt: "2026-10-20T12:00:00.000Z",
      },
      {
        id: "named-snapshot",
        recordId: "record",
        tableId: "table",
        createdBy: "22222222-2222-4222-8222-222222222222",
        createdByName: "Ada Example",
        createdAt: "2026-10-20T12:00:00.000Z",
      },
    ],
    "de",
  );
  expect(rows[0]?.createdBy).toBe("Unbekannte Person");
  expect(rows[1]?.createdBy).toBe("Ada Example");
  expect(rows[0]?.recordId).toBe("record");
});

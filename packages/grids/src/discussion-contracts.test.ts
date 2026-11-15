import { expect, test } from "bun:test";
import { BaseListDataSchema, BaseReaderDataSchema, RecordCapabilityDataSchema, RecordReaderDataSchema } from "./capability-contracts";

const timestamp = "2026-11-01T00:00:00.000Z";
const base = { id: "BASE01", name: "Projects", description: null, createdAt: timestamp, updatedAt: timestamp };
const record = {
  id: "REC001",
  tableId: "TABLE1",
  version: 1,
  deletedAt: null,
  createdBy: null,
  updatedBy: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

test("base readers require a standard view with an effective permission", () => {
  expect(BaseReaderDataSchema.safeParse(base).success).toBe(false);
  for (const permission of ["read", "write", "admin"]) {
    const data = { ...base, view: { title: base.name, permission } };
    expect(BaseReaderDataSchema.parse(data)).toEqual(data);
  }
  expect(BaseReaderDataSchema.safeParse({ ...base, view: { title: base.name, permission: "none" } }).success).toBe(false);
});

test("record readers require the current container ref and title beside existing metadata", () => {
  const view = { title: "Tasks · REC001", permission: "read" };
  expect(RecordReaderDataSchema.safeParse(record).success).toBe(false);
  expect(RecordReaderDataSchema.safeParse({ ...record, view }).success).toBe(false);
  const data = { ...record, view: { ...view, container: { ref: { type: "grids.base", id: base.id }, title: base.name } } };
  expect(RecordReaderDataSchema.parse(data)).toEqual(data);
});

test("existing list and record mutation results do not acquire reader-only requirements", () => {
  expect(BaseListDataSchema.parse([base])).toEqual([base]);
  expect(RecordCapabilityDataSchema.parse(record)).toEqual(record);
});

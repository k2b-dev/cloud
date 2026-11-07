import { expect, test } from "bun:test";
import { MachineRights } from "./machine-contracts";

test("machine authority is empty by default and HTTP grants bind an exact origin and method", () => {
  expect(MachineRights.parse({})).toEqual({ execute: false, storage: "none", database: "none", secrets: [], http: [], sharing: false });
  for (const origin of [
    "http://api.example.com",
    "https://api.example.com/path",
    "https://api.example.com/",
    "https://user:pass@api.example.com",
    "https://api.example.com?key=x",
  ])
    expect(MachineRights.safeParse({ http: [{ origin, methods: ["GET"] }] }).success).toBe(false);
  expect(MachineRights.safeParse({ http: [{ origin: "https://api.example.com", methods: ["GET"] }] }).success).toBe(true);
  expect(MachineRights.safeParse({ execute: true, personalSecrets: true }).success).toBe(false);
});

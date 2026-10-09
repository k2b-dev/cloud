import type { PermissionLevel } from "@k2b/cloud/contracts/shared";

/** A person or group that exists only within its scenario; each suite gives it its own ID. */
export type ScenarioPrincipal = { type: "user" | "group"; name: string };

export type PrecedenceScenario = {
  name: string;
  /** The base grants in order, each named by `key`. */
  grants: { key: string; principal: ScenarioPrincipal; permission: PermissionLevel }[];
  /** The grants that can be neither lowered nor removed. */
  locked: string[];
};

const quentin = { type: "user", name: "Quentin Dorn" } as const;
const lya = { type: "user", name: "Lya Meyer" } as const;
const staff = { type: "group", name: "Staff" } as const;
const interns = { type: "group", name: "Interns" } as const;

/**
 * Base grants where a deny may shadow a manager. The service suite checks that Grids refuses exactly the changes
 * of the `locked` grants, and the editor suite that the base access editor locks exactly those rows, so both
 * judge the same grants.
 */
export const precedenceScenarios: PrecedenceScenario[] = [
  {
    name: "a duplicate none grant shadows the second manager",
    grants: [
      { key: "qdt", principal: quentin, permission: "admin" },
      { key: "lym", principal: lya, permission: "admin" },
      { key: "lym-deny", principal: lya, permission: "none" },
    ],
    locked: ["qdt"],
  },
  {
    name: "a group deny shadows the group's own Manage grant",
    grants: [
      { key: "qdt", principal: quentin, permission: "admin" },
      { key: "staff", principal: staff, permission: "admin" },
      { key: "staff-deny", principal: staff, permission: "none" },
    ],
    locked: ["qdt"],
  },
  {
    name: "a deny for another group shadows nothing",
    grants: [
      { key: "staff", principal: staff, permission: "admin" },
      { key: "interns-deny", principal: interns, permission: "none" },
    ],
    locked: ["staff"],
  },
  {
    name: "two unshadowed managers",
    grants: [
      { key: "qdt", principal: quentin, permission: "admin" },
      { key: "lym", principal: lya, permission: "admin" },
    ],
    locked: [],
  },
];

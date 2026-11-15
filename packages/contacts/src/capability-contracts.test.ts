import { expect, test } from "bun:test";
import { z } from "zod";
import {
  ContactBookDataSchema,
  ContactBookReaderDataSchema,
  ContactDetailDataSchema,
  ContactMutationDataSchema,
  ContactReaderDataSchema,
} from "./capability-contracts";

test("discussion contact readers guarantee a current container and effective permission", () => {
  const schema = ContactReaderDataSchema.shape.view;
  const view = {
    title: "Ada Example",
    permission: "read",
    container: { ref: { type: "contacts.book", id: "Book01" }, title: "Customers" },
  };
  expect(schema.safeParse(view).success).toBeTrue();
  expect(schema.safeParse({ ...view, container: undefined }).success).toBeFalse();
  expect(schema.safeParse({ ...view, permission: "none" }).success).toBeFalse();
  expect(schema.safeParse({ ...view, permission: undefined }).success).toBeFalse();
});

test("book readers guarantee permission without requiring another container", () => {
  const schema = ContactBookReaderDataSchema.shape.view;
  for (const permission of ["read", "write", "admin"]) {
    expect(schema.safeParse({ title: "Customers", permission }).success).toBeTrue();
  }
  expect(schema.safeParse({ title: "Customers" }).success).toBeFalse();
});

test("standard reader views stay required while legacy domain and mutation shapes remain unchanged", () => {
  expect(z.toJSONSchema(ContactReaderDataSchema).required).toContain("view");
  expect(z.toJSONSchema(ContactBookReaderDataSchema).required).toContain("view");
  expect(z.toJSONSchema(ContactDetailDataSchema).properties).not.toHaveProperty("view");
  expect(z.toJSONSchema(ContactBookDataSchema).properties).not.toHaveProperty("view");
  expect(ContactMutationDataSchema.shape.contact).toBe(ContactDetailDataSchema);
});

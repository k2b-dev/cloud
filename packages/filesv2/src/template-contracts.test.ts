import { expect, test } from "bun:test";
import { TemplateFileSchema, TemplateGrantSchema, TemplateUpdateSchema } from "./template-contracts";

test("template input rejects path names, malformed bytes and unsupported grant principals", () => {
  for (const filename of ["../escape.md", "nested/file.md", "nested\\file.md", ".", "..", "file\u0000.md"]) {
    expect(TemplateFileSchema.safeParse({ filename, content: "" }).success).toBe(false);
  }
  expect(TemplateFileSchema.safeParse({ filename: "empty.md", content: "" }).success).toBe(true);
  expect(TemplateFileSchema.safeParse({ filename: "bad.md", content: "not base64" }).success).toBe(false);
  expect(TemplateGrantSchema.safeParse({ principal: { type: "public" } }).success).toBe(false);
  expect(TemplateGrantSchema.safeParse({ principal: { type: "service_account", serviceAccountId: crypto.randomUUID() } }).success).toBe(
    false,
  );
  expect(TemplateUpdateSchema.parse({ name: " Changed ", file: { filename: "new.md", content: "YQ==" } })).toEqual({
    name: "Changed",
    description: "",
    file: { filename: "new.md", content: "YQ==" },
  });
});

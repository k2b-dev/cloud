import { z } from "zod";
import { LIMITS } from "../contracts";
export const Value = z.union([z.string().max(LIMITS.text), z.number().finite(), z.boolean(), z.null()]);
export const FileOpenOptions = z.object({ accept: z.string().max(LIMITS.text).optional() }).strict();
export const SelectOption = z
  .object({
    value: z.string().max(120),
    label: z
      .string()
      .min(1)
      .max(120)
      .refine((label) => label.trim().length > 0, "Option label must be visible"),
    icon: z.string().max(120).optional(),
    description: z.string().max(LIMITS.text).optional(),
  })
  .strict();
export const LinkOptions = z.object({
  href: z
    .string()
    .max(LIMITS.text)
    .refine((href) => {
      try {
        return ["https:", "http:", "mailto:"].includes(new URL(href, "https://kit.invalid/").protocol);
      } catch {
        return false;
      }
    }, "Expected an HTTP, HTTPS, mailto or relative link"),
  newTab: z.boolean().default(false),
});
const ids = z.array(z.string().max(80)).max(LIMITS.nodes);
export const UiColumn = z.object({
  key: z.string().max(120),
  label: z.string().max(120),
  align: z.enum(["left", "center", "right"]).optional(),
});
export const UiNode = z
  .object({
    id: z.string().max(80),
    kind: z.enum([
      "text",
      "button",
      "input",
      "select",
      "table",
      "progress",
      "row",
      "column",
      "workbench",
      "section",
      "filePicker",
      "status",
      "list",
      "link",
      "linkButton",
      "markdown",
    ]),
    label: z.string().max(LIMITS.text).default(""),
    value: z.string().max(LIMITS.text).default(""),
    children: z.array(z.string().max(80)).max(LIMITS.nodes).default([]),
    columns: z.array(UiColumn).max(64).default([]),
    rows: z.array(z.record(z.string(), Value)).max(LIMITS.rows).default([]),
    options: z.array(SelectOption).max(200).default([]),
    description: z.string().max(LIMITS.text).default(""),
    placeholder: z.string().max(LIMITS.text).default(""),
    icon: z.string().max(120).default(""),
    disabled: z.boolean().default(false),
    loading: z.boolean().default(false),
    variant: z.enum(["primary", "secondary", "ghost", "text", "danger"]).default("secondary"),
    state: z.enum(["ready", "empty", "loading", "error"]).default("ready"),
    empty: z
      .object({
        title: z.string().max(LIMITS.text),
        description: z.string().max(LIMITS.text).default(""),
      })
      .optional(),
    controls: ids.default([]),
    content: ids.default([]),
    footer: z
      .object({
        status: z.string().max(80).optional(),
        actions: ids.default([]),
      })
      .optional(),
    items: z
      .array(
        z.object({
          id: z.string().max(180),
          title: z.string().max(LIMITS.text),
          description: z.string().max(LIMITS.text).default(""),
          icon: z.string().max(120).default(""),
          action: z.string().max(80).optional(),
        }),
      )
      .max(LIMITS.rows)
      .default([]),
    link: LinkOptions.optional(),
    headingScale: z.enum(["compact", "normal", "large"]).default("normal"),
    gap: z.enum(["sm", "md", "lg"]).default("md"),
    progress: z.number().min(0).max(1).default(0),
  })
  .strict();
export type UiNode = z.infer<typeof UiNode>;
export const WorkerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ui"), nodes: z.array(UiNode).max(LIMITS.nodes) }),
  z.object({
    type: z.literal("log"),
    level: z.enum(["log", "info", "warn", "error"]),
    text: z.string().max(LIMITS.text),
  }),
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("busy"), value: z.boolean() }),
  z.object({ type: z.literal("error"), text: z.string().max(LIMITS.text) }),
  z.object({
    type: z.literal("rpc"),
    id: z.number().int().nonnegative(),
    method: z.enum([
      "file.open",
      "file.openMultiple",
      "file.openFolder",
      "file.save",
      "store.get",
      "store.set",
      "store.delete",
      "store.keys",
      "opfs.read",
      "opfs.write",
      "opfs.delete",
      "opfs.list",
    ]),
    args: z.array(z.unknown()).max(4),
  }),
]);

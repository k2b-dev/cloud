import { z } from "zod";

// Match the platform's INTEGER storage. Zero is never allocated to a Cloud account.
export const PosixNumberSchema = z.number().int().min(1).max(2_147_483_647);
export const PosixPathSchema = z
  .string()
  .min(2)
  .max(4095)
  .refine(
    (value) =>
      value.startsWith("/") &&
      !/[\s:\x00-\x1f\x7f]/.test(value) &&
      !value
        .slice(1)
        .split("/")
        .some((part) => part === "." || part === ".." || part === ""),
    "Use an absolute path without whitespace, colons or relative segments",
  );

export const PosixIdentitySchema = z.object({
  userId: z.uuid(),
  managedBy: z.enum(["local", "ipa"]),
  uidNumber: PosixNumberSchema.nullable(),
  primaryGidNumber: PosixNumberSchema.nullable(),
  homeDirectory: z.string().nullable(),
  loginShell: z.string().nullable(),
});
export type PosixIdentity = z.infer<typeof PosixIdentitySchema>;

export const LinuxIdentityConfigurationSchema = z
  .object({
    enabled: z.boolean(),
    rangeStart: z.number().int().min(0).max(2_147_483_647),
    rangeEnd: z.number().int().min(0).max(2_147_483_647),
    homeTemplate: z.string().min(1).max(4095),
    loginShell: PosixPathSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.enabled && (value.rangeStart < 1000 || value.rangeEnd < value.rangeStart)) {
      ctx.addIssue({
        code: "custom",
        path: ["rangeStart"],
        message: "Choose a reserved range above system accounts (at least 1000), with end >= start",
      });
    }
    if (
      !value.homeTemplate.includes("{username}") ||
      !PosixPathSchema.safeParse(value.homeTemplate.replaceAll("{username}", "user")).success ||
      /[{}]/.test(value.homeTemplate.replaceAll("{username}", "user"))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["homeTemplate"],
        message: "Use an absolute home path containing {username}; no other placeholders are supported",
      });
    }
  });
export type LinuxIdentityConfiguration = z.infer<typeof LinuxIdentityConfigurationSchema>;
export const DEFAULT_LINUX_IDENTITY_CONFIGURATION: LinuxIdentityConfiguration = {
  enabled: false,
  rangeStart: 0,
  rangeEnd: 0,
  homeTemplate: "/home/{username}",
  loginShell: "/bin/bash",
};

export const PosixOverridesSchema = z.object({ homeDirectory: PosixPathSchema, loginShell: PosixPathSchema }).strict();
export const isPosixName = (value: string): boolean => /^[a-z_][a-z0-9_-]{0,31}$/.test(value);

import { z } from "zod";

/** One independently installable surface, separate from the Cloud mobile app's `pwa` parts. */
export const AppInstallableSchema = z.strictObject({
  path: z.string(),
  name: z.string().trim().min(1),
  shortName: z.string().trim().min(1),
  icon: z.string().regex(/^ti ti-[a-z0-9]+(?:-[a-z0-9]+)*$/),
  themeColor: z.strictObject({
    light: z.string().regex(/^#[0-9a-f]{6}$/i),
    dark: z.string().regex(/^#[0-9a-f]{6}$/i),
  }),
  display: z.literal("standalone"),
});
export type AppInstallable = z.infer<typeof AppInstallableSchema>;

/** No decoding or URL normalization: declarations must already be canonical. */
export const isInstallablePath = (appId: string, path: string): boolean =>
  /^[a-z][a-z0-9-]*$/.test(appId) &&
  path.startsWith(`/app/${appId}/`) &&
  /^\/app\/[a-z][a-z0-9-]*\/(?:[a-z0-9][a-z0-9-]*\/)+$/.test(path) &&
  !path.split("/").slice(3).includes("help");

export const installableContains = (scope: string, path: string): boolean => path === scope.slice(0, -1) || path.startsWith(scope);

/** Root and /app are routing fallbacks, not evidence that an app owns a surface. */
export const validateInstallable = (appId: string, routes: readonly string[], value: unknown): AppInstallable | null => {
  const parsed = AppInstallableSchema.safeParse(value);
  if (!parsed.success || !isInstallablePath(appId, parsed.data.path)) return null;
  const ownRoot = `/app/${appId}`;
  const covered = routes.some((route) => {
    const prefix = route.replace(/\/$/, "");
    return (
      /^\/app\/[a-z][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/.test(prefix) &&
      (prefix === ownRoot || prefix.startsWith(`${ownRoot}/`)) &&
      installableContains(`${prefix}/`, parsed.data.path)
    );
  });
  return covered ? parsed.data : null;
};

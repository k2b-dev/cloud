/** Name Bun's default pool before its first use without changing connection ownership. */
export const configurePostgresApplicationName = (
  applicationId: string,
  environment: Record<string, string | undefined> = process.env,
): void => {
  // Match Bun's precedence and preserve TLS_* variables, which imply required TLS.
  const variable = ["DATABASE_URL", "DATABASEURL", "TLS_DATABASE_URL", "POSTGRES_URL", "PGURL", "PG_URL", "TLS_POSTGRES_DATABASE_URL"].find(
    (key) => environment[key],
  );
  if (!variable) return;

  let url: URL;
  try {
    url = new URL(environment[variable]!);
  } catch {
    // Diagnostics must not change how Bun handles an existing connection configuration.
    return;
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return;

  let operatorConfigured = false;
  url.searchParams.forEach((_value, key) => {
    // options can contain an operator-owned `-c application_name=...` setting.
    if (key.toLowerCase() === "application_name" || key.toLowerCase() === "options") operatorConfigured = true;
  });
  if (operatorConfigured) return;

  url.searchParams.set("application_name", `cloud:${applicationId}`);
  environment[variable] = url.toString();
};

import { quoteIdentifier, StorePassword, StorePrefix, StoreUser } from "./validation";

export const READ_PROFILES = {
  read_small: { max_memory_usage: 1_000_000_000, max_execution_time: 10 },
  read_normal: { max_memory_usage: 2_000_000_000, max_execution_time: 10 },
  read_large: { max_memory_usage: 4_000_000_000, max_execution_time: 30 },
} as const;
export const READ_LIMITS = {
  max_result_rows: 10_000,
  max_result_bytes: 4_194_304,
  max_rows_to_read: 200_000_000,
  max_bytes_to_read: 20_000_000_000,
  result_overflow_mode: "throw",
  readonly: 1,
  cancel_http_readonly_queries_on_client_close: 1,
} as const;
export const DATABASE_RIGHTS = [
  "CREATE DATABASE",
  "DROP DATABASE",
  "CREATE TABLE",
  "DROP TABLE",
  "ALTER TABLE",
  "INSERT",
  "TRUNCATE",
  "OPTIMIZE",
] as const;
const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
export const randomHex = (bytes: number) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
export const hashServicePassword = async (password: string): Promise<{ sha256Hex: string; saltHex: string }> => {
  StorePassword.parse(password);
  const saltHex = randomHex(16);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password + saltHex));
  return { sha256Hex: hex(new Uint8Array(digest)), saltHex };
};

export const buildSetupSql = ({
  prefix = "pulse_",
  user,
  passwordSha256Hex,
  saltHex,
}: {
  prefix?: string;
  user: string;
  passwordSha256Hex: string;
  saltHex: string;
}): string => {
  StorePrefix.parse(prefix);
  StoreUser.parse(user);
  if (!/^[a-f0-9]{64}$/.test(passwordSha256Hex) || !/^[a-f0-9]{32}$/.test(saltHex)) throw new Error("Invalid salted password hash");
  const profiles = Object.entries(READ_PROFILES).map(([suffix, limits]) => {
    const settings = Object.entries({ ...limits, ...READ_LIMITS })
      .map(([name, value]) => `${name} = ${typeof value === "string" ? `'${value}'` : value} READONLY`)
      .join(",\n  ");
    const profile = quoteIdentifier(prefix + suffix);
    return `CREATE SETTINGS PROFILE IF NOT EXISTS ${profile} SETTINGS\n  ${settings};
ALTER SETTINGS PROFILE ${profile} SETTINGS\n  ${settings};`;
  });
  const who = quoteIdentifier(user);
  // ClickHouse reads a quoted `pulse_*` as one literal database name, so the wildcard stays bare; the
  // prefix is validated to lowercase letters, digits and underscores above.
  const databases = `${prefix}*.*`;
  return `-- Run as the ClickHouse admin with clickhouse-client --multiquery (or equivalent).
-- Creates Pulse read profiles (klein/normal/groß), a maintenance profile and service user.
-- Contains only a salted hash of the chosen password. Re-running updates the password and profiles.
-- This ClickHouse instance MUST serve only Pulse: user management is instance-wide,
-- so the service user can alter any user, including ClickHouse admins.
${profiles.join("\n\n")}

CREATE SETTINGS PROFILE IF NOT EXISTS ${quoteIdentifier(prefix + "maintenance")} SETTINGS max_memory_usage = 1000000000 READONLY;
ALTER SETTINGS PROFILE ${quoteIdentifier(prefix + "maintenance")} SETTINGS max_memory_usage = 1000000000 READONLY;
CREATE USER IF NOT EXISTS ${who};
ALTER USER ${who} IDENTIFIED WITH sha256_hash BY '${passwordSha256Hex}' SALT '${saltHex}' SETTINGS PROFILE '${prefix}maintenance';

-- Create, switch and remove read users; ClickHouse cannot restrict these rights by name.
GRANT CREATE USER, ALTER USER, DROP USER ON *.* TO ${who};
-- CREATE/DROP DATABASE: base lifecycle; CREATE/DROP/ALTER TABLE: owned schema lifecycle;
-- INSERT: ingest; TRUNCATE: clear base data; OPTIMIZE: maintenance.
GRANT ${DATABASE_RIGHTS.join(", ")} ON ${databases} TO ${who};
-- Delegate SELECT to base read users.
GRANT SELECT ON ${databases} TO ${who} WITH GRANT OPTION;
-- Storage accounting and free-space checks, limited to these two system tables.
GRANT SELECT ON system.parts TO ${who};
GRANT SELECT ON system.disks TO ${who};
-- Cancel Pulse queries; KILL QUERY WHERE reads system.processes. Dedicated instance required.
GRANT SELECT ON system.processes TO ${who};
GRANT KILL QUERY ON *.* TO ${who};
`;
};

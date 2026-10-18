# Connect the Pulse data store

Only a Cloud admin can use these commands. A Pulse base grant does not grant
store administration. Pulse currently keeps its telemetry in Postgres and works
without ClickHouse; connecting now prepares the store for later releases.

1. Ask the operator for a dedicated ClickHouse 26.9 or newer instance reachable
   from Pulse over HTTP or HTTPS. Its admin can read all Pulse data. The Pulse
   service user manages users instance-wide and could alter even admins, so do
   not share the instance with other applications.
2. Have the operator place the chosen service password in a private file or
   provide it on stdin. Never read the file into agent context, pass the value
   as a flag, include it in a URL, or print it.
3. Generate the setup script:

   ```sh
   cld pulse admin store setup-sql --user pulse_service --password-file /private/pulse.password
   ```

   Run the output as the ClickHouse admin using `clickhouse-client --multiquery`
   or equivalent. The script contains a salted hash only. It creates the
   klein/small, normal and groß/large read profiles, the maintenance profile,
   service user and scoped database grants. Re-running updates the password and
   restores profile limits.
4. Check and save the connection:

   ```sh
   cld pulse admin store set --url http://clickhouse:8123 --user pulse_service --password-file /private/pulse.password
   cld pulse admin store get --json
   cld pulse admin store check
   ```

`set` runs the full check before writing any settings. On a failed check, the
saved address, user and password stay unchanged; the command exits non-zero
with a fixed failure code and a repair hint. Omitting password input keeps the
saved password only for the saved address and user: a new address or user needs
the password again, so the stored secret never goes to another host. Omitting
`--user` keeps the saved or default user.

`get` returns configuration, `passwordSet`, and a connection-only check. It never
returns the password. `check` verifies the connection, version, rights and all
profile constraints with temporary objects, then removes them. All commands
have `--help`; `get`, `set` and `check` support the normal JSON output mode.
`setup-sql` writes SQL only, even with JSON output selected.

Use `--password-stdin` instead of `--password-file` to read one password from
stdin. These flags are mutually exclusive. One final line ending is removed;
spaces are preserved. Passwords must have 1–256 characters and no control
characters. The HTTP/HTTPS address must be an origin with no userinfo, path,
query or fragment.

The API is `/api/pulse/admin/store`: GET reads status, PUT checks and saves,
POST `/check` performs the full diagnostic (HTTP 200 even when `ok: false`),
and POST `/setup-sql` returns the script. Setup uses POST to keep the password
and its verifier out of proxy URL logs. A failed PUT returns HTTP 422 with
`STORE_CHECK_FAILED` and the sanitized check result.

For `UNREACHABLE`, check network, TLS and address. For `AUTH_FAILED`, check the
service credentials. For `VERSION_TOO_OLD`, upgrade to ClickHouse 26.9 or newer.
For `MISSING_RIGHT:<right>` or `PROFILE_MISSING:<profile>`, re-run the setup
script as ClickHouse admin. `TOO_MANY_RIGHTS` requires a dedicated service user
without admin privileges or inherited admin roles, and without rights to change
settings profiles, roles, quotas or row policies. `CLICKHOUSE_ERROR:<code>`
means ClickHouse refused the check for another reason, such as memory; check its
log and resources, then run `check` again.

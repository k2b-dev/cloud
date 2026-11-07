### Wait for the final Postgres server before creating smoke databases

- **What happened:** The image smoke job failed while creating the Notes database because Postgres was shutting down immediately after its readiness check passed.
- **Root cause:** The official Postgres image runs a temporary Unix-socket-only server during initialization. The socket readiness check accepted that server before the entrypoint stopped it and started the final server.
- **Error class:** A readiness probe accepts a temporary initialization process instead of the service that consumers need.
- **Guard:** The image smoke job uses `pg_isready -h 127.0.0.1` before creating databases or starting consumers. The temporary initialization server does not listen on TCP, so the probe waits for the final server.

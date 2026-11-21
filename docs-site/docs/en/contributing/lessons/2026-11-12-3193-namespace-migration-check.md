### Verify generated constraint names before replacing them

- **What happened:** Database provisioning failed after adding incarnation suffixes to namespace names.
- **Root cause:** The migration dropped an assumed column constraint name, while Postgres named the legacy check after its table because it references two columns.
- **Error class:** A schema migration leaves an incompatible constraint in place.
- **Guard:** The retention integration suite preserves legacy names, accepts new incarnations across migration reruns and rejects another Code's namespace. Bridge tests verify provisioning, quota growth and lock availability through the same migration.

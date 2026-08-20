# Capabilities

Use capabilities when an installed app publishes a typed public Query or
Action and no more ergonomic app-specific command is needed.

```bash
cld capabilities catalog --json
cld capabilities read contacts.contact <contact-id> --json
cld capabilities query contacts search \
  --input '{"query":"Ada","tags":["contact"],"limit":10}' \
  --json
cld capabilities action contacts create \
  --input-file ./contact.json \
  --idempotency-key contacts-import-42 \
  --json
```

- `catalog` is the source of truth. Read its ids, descriptions, input schema,
  result schema, safety metadata, and semantic links before invoking a tool.
- Query and Action ids after the app id are app-local ids from the live catalog.
- `read` resolves a qualified resource Type through its declared canonical
  reader and invokes that ordinary Query with the supplied stable id.
- Pass one strict JSON object through `--input`, `--input-file`, or stdin.
- Read the Action's idempotency policy from the catalog. Supply a stable key
  when it is `required`; reuse it only for the identical logical request. Do
  not supply a key when the policy is `none`.
- A direct `cld capabilities action` call is an explicit invocation. The CLI
  does not store or apply AI Core's remembered approvals; `approval` and Action
  reviews are client policy used by supporting AI experiences.
- Use `--json` for one complete result and `--jsonl` only when the surrounding
  automation expects a stream record.
- Treat `VALIDATION_FAILED` details as recoverable input guidance. Refresh the
  catalog after `SCHEMA_MISMATCH`, `CAPABILITY_NOT_FOUND`, or `APP_UNAVAILABLE`.
- `refs` are stable app-owned identities. `links` are root-relative Cloud URLs
  for opening, editing, previewing, downloading, or checking status.

Capabilities do not bypass app authorization. Core authenticates the caller,
then the owning app reconstructs the actor/access subject and checks current
resource access again.

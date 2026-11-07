# Apps

`cld apps` lists the Cloud apps that the signed-in user can open. Run it before choosing an app command: the list reflects the live installation and the user's access.

```bash
cld apps list --json
cld apps list --search mail --json
```

Each item carries `id`, `name`, `description`, `icon`, and `href`. The `id` is the app's command module when the app serves one; `cld plugins list` shows which modules this Cloud serves and which are installed.

Administrators can inspect one app, including an offline app known to Core:

```bash
cld apps show filesv2
cld apps show filesv2 --json
```

The result contains `app`, `access`, `sends`, `hears`, `notifications`, and
`totals`. It includes requested platform permissions, localized declarations,
subscription states and delivery counts. New subscriptions are marked for seven
days. Each list is limited to 100 entries, with full counts in `totals`; each
subscription includes up to five recent failed deliveries. Use their IDs with
`cld events redeliver <delivery-id> --yes` after fixing the cause. Unknown app
IDs return 404; an administrator role and OAuth `admin` scope are required.

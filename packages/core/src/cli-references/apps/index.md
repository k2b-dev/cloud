# Apps

`cld apps` lists the Cloud apps that the signed-in user can open. Run it before choosing an app command: the list reflects the live installation and the user's access.

```bash
cld apps list --json
cld apps list --search mail --json
```

Each item carries `id`, `name`, `description`, `icon`, and `href`. The `id` is the app's command module when the app serves one; `cld plugins list` shows which modules this Cloud serves and which are installed.

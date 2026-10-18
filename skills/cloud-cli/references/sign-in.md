# Sign-in and profiles

After a successful sign-in, `cld` offers to install the plugins the Cloud serves and, the first time, asks where to write this skill (`--yes` accepts both defaults; `--no-plugins` skips the plugin offer).

## Sign in

`cld login` signs in with the user's Cloud account and stores a refreshable OAuth login in a profile. It always uses Cloud's first-party `cloud-cli` client.

```bash
cld login --server https://cloud.example
cld login portal --server https://cloud.example
```

The first form uses the current profile (or `default`); the second names the profile. On a desktop, `cld` offers to open the browser and receives the result on a loopback callback. The browser tab then shows a small page in the browser's language (English or German): the Cloud CLI is connected and the tab can be closed, or access was denied or the Cloud rejected the request and you run `cld login` again. The page reports only what the browser sent back. `cld` then finishes the sign-in and stores the profile, so the terminal has the final result: trust its output and exit code, not the tab. Use `--no-open` to only print the URL.

## Sign in on a headless machine

On a server reached over SSH, in a container, or anywhere without a browser, the loopback callback cannot reach `cld`. Use the device flow instead:

```bash
cld login --server https://cloud.example --device
```

```text
Open https://cloud.example/oauth/device and enter the code: WDJB-MJHT
(or open https://cloud.example/oauth/device?user_code=WDJB-MJHT)
Waiting for approval…
✓ Signed in as Valentin Kolb (profile "default")
```

The user opens the URL on a laptop or phone, signs in, checks that the code matches, and approves. The page then says the device is connected and the tab can be closed. `cld` polls until then and stores the login exactly like a browser login, including `--fd0` and the refresh token. The code expires after ten minutes; a denied or expired code exits with status 1 and stores nothing.

As an agent on a headless box, run the command, show the user the URL and code, and wait. Do not ask for a password, session cookie, or API key instead. The user should approve only a code they expect; the approval page says so.

In an SSH session, or when `--no-open` is used, the normal `cld login` prints a hint to use `--device`.

## Sign in with Cloud Login

When the user has paired Cloud Login on a phone, `--user` sends the sign-in to that phone. Nobody opens a URL or types a code:

```bash
cld login --server https://cloud.example --user alice
```

```text
Compare this code in Cloud Login: 123 456
Waiting for approval… (Ctrl+C cancels)
✓ Signed in as Alice Example (profile "default")
Login expires: 2026-10-19T08:00:00.000Z
```

Pass the user's username or email. The user compares the six digits with the code in Cloud Login, checks the listed rights and lifetime, and approves with a single tap. `cld` stores the login like any other. `--user` cannot be combined with `--device` or `--no-open`.

The request expires after 5 minutes. Ctrl+C stops waiting and exits with status 130. `cld` cannot tell whether the account exists or has a paired phone. When nobody approves in time, it prints `No confirmation received` and the matching `--device` command; sign in with that command or in the browser. A denied request exits with status 1 and stores nothing. Cloud Login does not approve the `admin` scope; use the browser or `--device` for it.

An older Cloud refuses `--user` with `This Cloud cannot send sign-ins to Cloud Login yet` and the matching `--device` command.

## Limit a login with --ttl

`--ttl` ends a login after a fixed time. It works with the browser, `--device`, and `--user`:

```bash
cld login --server https://cloud.example --user alice --ttl 8h
cld login --server https://cloud.example --device --ttl 30m
```

Use `30m`, `8h`, `2d`, or a whole number of seconds. `--ttl` can only shorten a login: the Cloud caps it at its session length. `cld` prints the actual end as `Login expires: <time>`, and `cld auth status` shows `Login expires` or `Login expired`. Refreshes never extend the end. After it, commands that need the login fail before they send a request and print the exact `cld login` command to sign in again. An older Cloud refuses `--ttl`; sign in without it.

Without `--ttl`, a `--user` login lasts the Cloud's session length. Browser and `--device` logins last 90 days.

As an agent on a headless box, prefer `--user <the user's username or email>` when the user has paired Cloud Login, otherwise `--device`. Tell the user to approve only the code shown in your terminal. Pass a `--ttl` that fits the task, such as `--ttl 2h` for one session of work. Never ask for a password or token. To sign in with fewer rights, pass `--scope`.

## Profiles

```bash
cld profile list
cld profile use portal
cld auth status
cld logout --profile portal
cld profile rm portal
```

An OAuth profile stays bound to the server it signed in to. To move it, run `cld login <profile> --server <url>` again. Re-login and `cld logout` revoke the previous refresh grant.

`cld profile rm <name>` removes a profile for good: it signs the profile out like `cld logout`, deletes it with its installed plugins (plugin versions another profile uses stay), and rewrites the module table of this skill. It refuses the current profile while other profiles exist; run `cld profile use <other>` first. It asks for confirmation and, without a terminal, refuses unless `--yes` is given. Pass `--yes` only when the user asked to remove that exact profile.

Keep the refresh token in fd0 instead of the config file:

```bash
cld login --server https://cloud.example --device --fd0
cld login --server https://cloud.example --fd0 my-cloud-refresh --fd0-scope work
```

Run `cld login --help` for every option.

## Agent profiles

An administrator provisions an agent account with `cld admin agents create <name> --profile <profile>` (see `cld admin reference`). The profile then holds the agent's OAuth client ID and secret; `cld` obtains an access token through the client-credentials grant on first use, caches it, and renews it after a `401`. There is no browser step and no refresh token.

```bash
cld --profile release-agent auth status
cld --profile release-agent account whoami
cld logout --profile release-agent
```

`auth status` reports `client-credentials` and where the secret is kept (`config` or `fd0:<name>`). `profile show` masks the secret. `logout` removes the credentials locally only; the administrator revokes the agent with `cld admin agents revoke` or rotates its secret with `cld admin agents rotate-secret`. A rejected credential means the agent was disabled or its secret rotated; `cld` says so instead of retrying.

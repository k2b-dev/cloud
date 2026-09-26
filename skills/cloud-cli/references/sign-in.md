# Sign-in and profiles

After a successful sign-in, `cld` offers to install the plugins the Cloud serves and, the first time, asks where to write this skill (`--yes` accepts both defaults; `--no-plugins` skips the plugin offer).

## Sign in

`cld login` signs in with the user's Cloud account and stores a refreshable OAuth login in a profile. It always uses Cloud's first-party `cloud-cli` client.

```bash
cld login --server https://cloud.example
cld login portal --server https://cloud.example
```

The first form uses the current profile (or `default`); the second names the profile. On a desktop, `cld` offers to open the browser and receives the result on a loopback callback. Use `--no-open` to only print the URL.

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

The user opens the URL on a laptop or phone, signs in, checks that the code matches, and approves. `cld` polls until then and stores the login exactly like a browser login, including `--fd0` and the refresh token. The code expires after ten minutes; a denied or expired code exits with status 1 and stores nothing.

As an agent on a headless box, run the command, show the user the URL and code, and wait. Do not ask for a password, session cookie, or API key instead. The user should approve only a code they expect; the approval page says so.

In an SSH session, or when `--no-open` is used, the normal `cld login` prints a hint to use `--device`.

## Profiles

```bash
cld profile list
cld profile use portal
cld auth status
cld logout --profile portal
```

An OAuth profile stays bound to the server it signed in to. To move it, run `cld login <profile> --server <url>` again. Re-login and `cld logout` revoke the previous refresh grant.

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

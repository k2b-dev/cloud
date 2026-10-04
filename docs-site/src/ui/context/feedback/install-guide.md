# InstallGuide

`InstallGuide` explains how to install the current page as an app in the
browser in use. Where the browser offers its own installation dialog, it shows
an Install button. Otherwise it lists the steps for Safari on iPhone and iPad,
other browsers on iPhone and iPad, Android, Safari on a Mac, or other
browsers. A browser on iPhone or iPad other than Safari, and one on Android
other than Chrome, gets a notice above its steps that names the browser that
installs most reliably.

A browser inside another app, such as a social, mail, or QR-scanner app,
cannot install at all. There the guide shows a warning instead of steps: open
this page in Safari (on iPhone and iPad) or in the browser (elsewhere), with
one **Copy link** button.

## Import

```tsx
import { createInstallPrompt, InstallGuide, type InstallPrompt, installationPlatform } from "@k2b/ui";
```

## Use InstallGuide

Create the installation state once with `createInstallPrompt()`, as early as
possible: at the root of the island or browser app, when the page loads.
Chrome offers its installation dialog through one `beforeinstallprompt` event
shortly after the page loads, and state created later, for example when a
settings section or a dialog opens, never sees it; the guide then shows manual
steps instead of the Install button. Pass the state down to the guide, also
into a dialog that opens later, with the app's name and address:

```tsx
const install = createInstallPrompt();

<Show when={!install.installed()}>
  <InstallGuide appName="Northwind" install={install} url={`${location.origin}/app/`} />
</Show>
```

- `appName` is the name people see on their Home Screen.
- `url` is the address that **Copy link** copies inside another app, for
  example the app's start page or a link the person must take along.
- `note` adds an application note under the steps, or under the link inside
  another app, for example what else the installed app enables or where the
  app offers installation again. Pass the note that fits `install.platform`.

The host owns the surface around the guide: its heading, a dialog or page, and
dismissal. Hide the guide or close its dialog when `install.installed()`
becomes true.

### Installation state

`createInstallPrompt()` captures the browser's `beforeinstallprompt` offer and
tracks whether the page runs installed. It returns:

- `platform`, from `installationPlatform(userAgent, platform, touchPoints)`:

  | Value | Browser | Guide |
  | --- | --- | --- |
  | `"apple-mobile"` | Safari on iPhone or iPad, also an iPad that reports a Mac | Share steps |
  | `"apple-browser"` | Chrome, Firefox, Edge, or another browser on iPhone or iPad | Notice that Safari works best, then the Share steps |
  | `"apple-in-app"` | A browser view inside another app on iPhone or iPad | Warning to open the page in Safari, and **Copy link** |
  | `"apple-desktop"` | Safari on a Mac | Dock steps |
  | `"android"` | Chrome on Android | Menu steps |
  | `"android-browser"` | Another browser on Android | Notice that Chrome works best, then the menu steps |
  | `"in-app"` | A browser view inside another app elsewhere | Warning to open the page in the browser, and **Copy link** |
  | `"generic"` | Any other browser | Menu steps and a note that installation may be missing |

  It reads tokens of known apps and browsers from the user agent. A view
  inside an app on iPhone or iPad that names no app is recognised by the
  missing `Safari/` token. A Safari view inside another app sends Safari's
  user agent and counts as Safari, so the Safari steps end with a hint for
  that case. The classifier names the browser, not the device: an installed
  app on iPhone may itself look like a view inside another app. Use your own
  operating-system check to name a device.
- `installed()`: the page runs from the Home Screen or as an installed app, or
  was installed during this visit.
- `canPrompt()`: the browser offered its own dialog.
- `install()`: opens that dialog once. Call it directly from a click.
- `busy()`, `requested()` (the person accepted), and `failed()` (the dialog
  could not open) describe the attempt.

The guide uses the same state, so its button and steps follow it. Remember on
your own whether the person already saw an installation introduction.

## Accessibility

The steps are an ordered list with a heading per step; the icons are
decorative. A failed dialog is announced as an alert and an accepted one as a
status. Inside another app, the address appears as text when copying fails,
so it can be copied by hand. Notices and warnings say in text which browser to
use, so they never depend on colour.

## Runtime

`createInstallPrompt()` needs the browser: `navigator`, `matchMedia`, and
window events. It removes its listeners when its owner is disposed, so create
it under an owner that lives as long as the page. `installationPlatform()` is a
pure function of its arguments and also runs on the server, so a page can
render the right guide with its first response and the browser computes the
same value. Render the guide in a hydrated island or a dialog.

## Example

```tsx
// Created at the island root when the page loads, and passed to the section.
function InstallSection(props: { install: InstallPrompt }) {
  const install = props.install;
  return (
    <Show when={!install.installed()}>
      <section>
        <h2>Install the app</h2>
        <InstallGuide appName="Northwind" install={install} url={`${location.origin}/app/`} />
      </section>
    </Show>
  );
}
```

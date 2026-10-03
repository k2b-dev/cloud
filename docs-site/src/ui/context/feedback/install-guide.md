# InstallGuide

`InstallGuide` explains how to install the current page as an app in the
browser in use. Where the browser offers its own installation dialog, it shows
an Install button. Otherwise it lists the steps for Safari on iPhone and iPad,
Android, Safari on a Mac, or other browsers. In an in-app browser, such as one
inside a social app, it offers the link to open in Safari or Chrome.

## Import

```tsx
import { createInstallPrompt, InstallGuide, installationPlatform } from "@k2b/ui";
```

## Use InstallGuide

Create the installation state with `createInstallPrompt()` in the browser,
inside a component, and pass it to the guide with the app's name and address:

```tsx
const install = createInstallPrompt();

<Show when={!install.installed()}>
  <InstallGuide appName="Northwind" install={install} url={`${location.origin}/app/`} />
</Show>
```

- `appName` is the name people see on their Home Screen.
- `url` is the address an in-app browser copies.
- `note` adds an application note under the steps, for example what else the
  installed app enables.

The host owns the surface around the guide: its heading, a dialog or page, and
dismissal. Hide the guide or close its dialog when `install.installed()`
becomes true.

### Installation state

`createInstallPrompt()` captures the browser's `beforeinstallprompt` offer and
tracks whether the page runs installed. It returns:

- `platform`: `"apple-mobile"`, `"apple-desktop"`, `"android"`, `"in-app"`, or
  `"generic"`, from `installationPlatform(userAgent, platform, touchPoints)`.
  An iPad that reports a Mac counts as `"apple-mobile"`.
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
status. In an in-app browser, the address appears as text when copying fails,
so it can be copied by hand.

## Runtime

`createInstallPrompt()` and `installationPlatform()` need the browser:
`navigator`, `matchMedia`, and window events. Render the guide in a hydrated
island or a dialog. It removes its listeners when its owner is disposed.

## Example

```tsx
function InstallSection() {
  const install = createInstallPrompt();
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

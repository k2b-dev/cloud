---
id: core-profile
title: Profile
icon: ti ti-user-circle
description: Review your account, groups, and activity, request FreeIPA access, and use API keys and passkeys.
updated: 2026-11-10
order: 110
---

Your account area combines local Cloud data, optional FreeIPA data, and the actions that you can take for yourself.

## Review your account {icon="paperclip"}

:::reference
- **Profile:** Shows display name, username, avatar, provider, profile type, extra roles, email, phone, and address. **Account facts** also shows account expiry and password expiry when they are available.
- **Groups → Group memberships:** Shows your direct group memberships first. **Show inherited** adds the memberships that come through the group hierarchy.
- **Groups → FreeIPA account:** A local account can request FreeIPA access when account requests, the FreeIPA connection, and FreeIPA accounts are all enabled. You can still withdraw a pending request after new requests are turned off.
- **Approvals:** Shows your waiting Action requests across apps. You can approve or reject them here. Each request links to the chat that waits for it.
- **Sign-in → Account activity:** Shows recent security-relevant account activity for the last 7, 30, or 90 days.
:::

## Protect sign-in and automation {icon="shield-lock"}

:::reference
- **Developer → API keys:** Personal keys for automation. A key with **Full access** has the same access as your account. When your administrator offers the OpenAI-compatible API, you can choose **AI models only** instead: such a key can only call the AI models you may use in Assistant, for example from a dictation app. Cloud shows the full key only once, right after you create it.
- **Sign-in → Passkeys:** WebAuthn passkeys for passkey sign-in to your account. After you remove a passkey, nobody can sign in with it.
:::

Create API keys under **Developer** and passkeys under **Sign-in** in the
browser. Your browser sign-in must be from the last ten minutes. If Cloud asks
you to confirm your identity, sign in again with the same account. The dialog
then opens again. The Cloud app, command-line sign-in, and existing API keys cannot
create personal API keys or passkeys.

## Choose your appearance {icon="palette"}

The profile menu shows your current appearance as one entry. Choose it to
switch to the next: **Automatic**, **Light**, **Dark**, then **Automatic**
again. The menu stays open. Automatic is the default. It follows your
device's light or dark setting.

## Hide your content with the privacy screen {icon="eye-off"}

The privacy screen hides your content when someone looks over your shoulder.
It locks nothing. The app bar stays visible, but you cannot use it.

:::reference
- **Now:** In the profile menu, choose **Privacy screen now**, or press
  **Ctrl+.** (**⌘+.** on a Mac). The
  shortcut also works while a dialog is open.
- **Automatically:** When you do not use Cloud for two minutes, Cloud hides
  your content. In the profile menu, choose another time or **Off** under
  **Hide automatically**. Profile settings show the same setting under **At
  your screen**. It applies on every computer where you sign in.
- **Countdown:** Ten seconds before, a symbol with a ring that empties shows
  above your profile. Any key or mouse movement stops the privacy screen.
- **Continue working:** Press a key or choose any place on the page. The page
  does not get this input. A mouse movement only lights up the hint.
:::

The privacy screen applies to all Cloud tabs of this browser. A running
dictation and the progress of an upload stay visible. Cloud does not hide
notifications of the operating system. Phones and tablets without a mouse or
touchpad have no privacy screen.

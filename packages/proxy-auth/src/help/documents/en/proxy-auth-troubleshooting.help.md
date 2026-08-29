---
id: proxy-auth-troubleshooting
title: Troubleshooting
icon: ti ti-lifebuoy
description: Diagnose login loops, denied users, missing identity headers, and invalid verify URLs.
order: 120
---

## Read the result first {icon="square-plus"}

:::reference
- **Redirect to login:** The request has no valid Cloud session. Confirm the browser can reach the normal Cloud login and that cookies are sent for the expected origin.
- **403 Forbidden:** The user is signed in but belongs to none of the allowed groups. Check effective and nested group membership.
- **404 or invalid client:** The verify URL is wrong or the client was deleted. Copy the current URL from the client action menu.
- **Upstream receives no identity:** Confirm the ForwardAuth middleware forwards the response headers listed on the Proxy Auth page.
:::

## Diagnosis path {icon="lifebuoy"}

:::steps
1. Test the protected route in a normal browser session.
2. Confirm the Proxy Auth client still exists and has allowed groups.
3. Compare the configured verify URL with the current copied value.
4. Check the user's effective group membership in Accounts.
5. Inspect Traefik logs for the middleware result and upstream header forwarding.
:::

:::note Authentication and authorization are separate
A successful Cloud login proves who the user is. Proxy Auth still returns 403 when that identity is outside the client's allowed groups.
:::

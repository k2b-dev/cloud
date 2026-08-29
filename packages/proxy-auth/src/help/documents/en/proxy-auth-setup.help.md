---
id: proxy-auth-setup
title: Configure Traefik
icon: ti ti-route
description: Connect a client verify URL to ForwardAuth and forward the returned identity headers.
order: 110
---

Proxy Auth decides whether a signed-in Cloud user may reach one protected service. Traefik remains responsible for calling the verify URL before it forwards the original request.

## Setup path {icon="square-plus"}

:::steps
1. Create a Proxy Auth client for one protected service or route.
2. Add at least one allowed group.
3. Copy the generated verify URL.
4. Configure that URL as the address of a Traefik ForwardAuth middleware.
5. Configure the middleware to pass the identity response headers shown on the Proxy Auth page.
6. Attach the middleware to the protected router.
7. Test logged out, with an allowed user, and with a signed-in user outside the allowed groups.
:::

## Choose groups deliberately {icon="book-2"}

- Use a purpose-specific group when the service should not inherit broad platform access.
- Nested group membership counts toward effective access.
- A client without allowed groups intentionally denies every authenticated user.
- Keep separate clients for services that need different group gates, even if they share an upstream host.

:::warning The verify URL is configuration, not a user link
Users should open the protected service. Traefik calls the verify URL in the background for each protected request.
:::

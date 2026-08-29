---
id: proxy-auth-start
title: Start
icon: ti ti-load-balancer
description: ForwardAuth clients, group gates, verify URLs, and response headers.
order: 100
---

Proxy Auth lets admins protect external services through Traefik ForwardAuth by creating one verify endpoint per client and allowing access for selected account groups.

## Overview {icon="layout-grid"}

:::reference
- **Client:** One protected external service or route. Each client has a stable verify URL with its own client id.
- **Allowed groups:** A user must belong to at least one allowed group before the verify endpoint returns access.
- **Verify URL:** Traefik calls `/proxy-auth/verify/<client-id>` before forwarding the original request to the upstream service.
- **Forwarded headers:** On success, the endpoint returns user, email, and effective direct or nested group headers for the upstream service.
:::

## Admin workflow {icon="route"}

:::reference
- **Create a client:** Name the client, add a description if useful, and select at least one allowed group.
- **Copy the verify URL:** Copy the URL after creation or from the client action menu, then place it in the Traefik ForwardAuth middleware.
- **Review group coverage:** The No groups stat highlights clients that are blocked until a group is configured.
- **Update access:** Edit a client to change the description or allowed groups. Delete removes the client and invalidates its verify URL.
:::

:::info Access result
The verify endpoint redirects unauthenticated users to login, returns 403 for authenticated users outside the allowed groups, and returns 200 with forwarded identity headers when access is allowed.
:::

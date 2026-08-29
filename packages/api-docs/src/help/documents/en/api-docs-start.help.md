---
id: api-docs-start
title: Start
icon: ti ti-books
description: Choose an API, read an operation, understand schemas and authentication, and use the CLI reference.
order: 100
---
API Docs collects the OpenAPI references published by running Cloud apps. Start here before choosing an app from the source selector.

## Find the API you need {icon="search"}

- Choose the app that owns the data or action you want to use.
- Use the reference search for an operation name, route, field, or schema.
- Open an operation to see its HTTP method, path, parameters, request body, responses, and declared authentication.
- Use schemas to understand reusable objects shared by several operations.

## Read an operation {icon="route"}

:::steps
1. Confirm the selected app.
2. Read the summary and description before copying the path.
3. Check every required path, query, or header parameter.
4. Match the request body to the documented schema.
5. Review success and error responses before integrating the operation.
:::

:::warning Documentation does not grant access
An operation can appear in API Docs even when your account or integration cannot call it. Use the documented authentication and request only the access the integration needs.
:::

## Use the CLI {icon="code"}

- `cld api-docs list` lists apps that currently publish a reference.
- `cld api-docs operations <app>` lists one app's operations.
- `cld api-docs search "<query>"` searches operation metadata and schemas.
- `cld api-docs show <app> <method> <path>` shows one operation in detail.
- `cld api-docs spec <app>` prints the raw OpenAPI document.

If an expected app is missing, it is not currently publishing a safe OpenAPI source to the live app registry.

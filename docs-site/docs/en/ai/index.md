---
title: AI
navTitle: Overview
section: AI
order: 1000
description: Choose the smallest model runtime while keeping application authority explicit.
tags: [ai, models, tools]
updated: 2026-08-18
---

# AI

Cloud provides a shared runtime for model-backed features.

Cloud owns one personal conversation model for every user. Core supplies the
global `/api/ai` runtime, storage, streaming, approvals, files, Projects,
Skills, personalization, and recovery. Assistant is the standard GUI for those chats;
applications attach Cloud resources and publish Capabilities instead of owning
another chat silo.

The application still owns the product behavior. It decides:

- who may use the feature;
- which domain data enters the model context;
- which queries and actions it publishes as Capabilities;
- how the result changes application state.

That ownership does not move into a prompt. Cloud can authenticate the caller,
store a turn, validate schemas, and pause for approval, but only the application
knows which domain data may be disclosed and which operation is allowed now.

## Choose the smallest API

| Need | Start with |
| --- | --- |
| Open the personal agent with initial text, files, or Cloud resources | [`POST /api/ai/conversations`](/en/docs/ai/chat-runtime-and-streaming) |
| One validated background result | [`runAiStructured()`](/en/docs/ai/structured-and-background-ai) |
| A reusable application query or action | [Capabilities](/en/docs/platform/capabilities) |
| A local runtime-only model tool | [`defineAiTool()`](/en/docs/ai/tools-and-approvals) |
| Conversation files, Projects, Skills, or user memory | [Files, Projects, Skills, and personalization](/en/docs/ai/files-projects-and-personalization) |
| Shared chat components | [Chat interface](/en/docs/ai/chat-interface) |

Do not create a chat when one structured call is enough. Do not create a custom
tool when a stable app operation should be published once as a
[Capability](/en/docs/platform/capabilities) for several consumers.

## Keep the application boundary

Cloud resolves the current user before it starts a turn. A referenced resource,
Capability name, or Assistant deep link grants no access. The owning application
authenticates every Capability call and checks its current domain permissions.

Model credentials stay on the server. Browser code sees sanitized model
metadata, not provider secrets.

Cloud records conversations and tool results. The application database remains
the source of truth for domain data.

> Treat model output as untrusted input. Validate it before a write and run the
> same authorization checks used by a normal request.

Start with [AI resources and access](/en/docs/ai/resources-and-access) for an
application entry point. Read [Chat runtime and streaming](/en/docs/ai/chat-runtime-and-streaming)
for the conversation lifecycle and [Models and providers](/en/docs/ai/models-and-providers)
for deployment configuration.

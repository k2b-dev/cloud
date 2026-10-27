---
title: Upgrading to model classes
section: Operations
order: 1225
description: Recreate AI configuration after the breaking move from profiles to model classes.
tags: [operations, ai, migration]
updated: 2026-10-27
---

# Upgrading to model classes

This upgrade discards AI configuration. There is no compatibility bridge.
Until an operator recreates models and assigns a class, inference fails with
`ai_no_model`. The AI enabled switch still applies.

Cloud removes profiles, their keys and headers, model access grants, the five
old default/tool model settings, model-specific budget rules, project default
models and each person's last model selection. All-model budget rules and
conversation and inference history remain.

1. Before upgrading, record the old configuration using a JSON export without
   secrets. Have the provider API keys ready separately.
2. After upgrading, create and test providers, then add models, prices, access
   grants and variants. Follow [Models and providers](/en/docs/ai/models-and-providers).
3. Assign at least balanced under model classes. Configure the vision and
   audio slots where those tools are needed.
4. Recreate model-specific budget rules and project default model requests.
5. Change workflows with fixed models to a class or a new variant ID. Tell
   OpenAI-compatible API clients about the new IDs and the `cloud/fast`,
   `cloud/balanced`, `cloud/thorough` and `cloud/maximum` class identifiers.

Verify a chat, the tools in use and a representative workflow. Check that
allowed people see the expected choices and that budgets cover the intended
models. Old fixed IDs intentionally fail until replaced.

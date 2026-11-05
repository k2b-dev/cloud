---
id: core-ai-decisions
title: Ask a decision model
icon: ti ti-sparkles
description: Classify information with probabilities in Gustav, Code or the CLI.
order: 600
---

Ask Gustav to classify information with a decision model when you need a category,
yes/no estimate or score with probabilities. A Cloud administrator must first
assign a decision model in the AI settings. You also need permission to use it
and enough AI allowance. Code uses the allowance of its person or service account.
Resource- and app-owned Code accounts need their own model grant and, when
quotas are enabled, their own allowance grant; personal defaults do not apply.
The Cloud-Admin's Code policy decides whether a version using AI needs approval.

## Classify a message {icon="mail"}

Ask for the category first. Ask about urgency together with the category, or after
it. Never ask urgency alone: spam often uses urgent wording. Use urgency only
within a relevant category, such as support. Probabilities are estimates; check
uncertain messages yourself before acting.

The decision reads the supplied information and changes no mail or other records.
Any later change is a separate action. Images work only when both the provider
and model support them, and must fit within the call's size limit.

## If the decision fails {icon="alert-circle"}

If no model is configured, ask a Cloud administrator to assign one. If you cannot
use the selected model, choose one shared with your account. For an exhausted
allowance, check your AI usage before retrying. Reduce large inputs or remove
unsupported images. A failed or canceled decision provides no answer to act on.

### Check aggregate contracts after a main sync

- **What happened:** The sync gate rejected Runner's old Bun image, a Mail settings fixture, the deployment mount fixture and the combined Mail Skill length.
- **Root cause:** Main advanced the Bun mirror and added settings/deployment expectations while Code added Runner's custom mount and more Mail guidance. The automatic merge preserved both branches' lines but left their aggregate contracts inconsistent.
- **Error class:** Clean text merges can leave stale fixtures and violate shared dependency or size budgets.
- **Guard:** The mirror allowlist check covers both Runner image stages. Mail's package typecheck covers the complete admin fixture. The deployment regression checks Runner's absolute mount and generated fixture key in development and production. The existing Mail Skill test retains its 5,000-character budget; concise guidance preserves the merged behavior.

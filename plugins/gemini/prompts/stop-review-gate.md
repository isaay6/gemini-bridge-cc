<task>
Run a stop-gate review of the previous Claude turn.
Only review direct code changes made in that previous turn. Do not review pure status, setup, reporting, or earlier edits.
If the previous turn did not make code changes, return ALLOW immediately without further work.
Challenge whether that specific work and its design choices should ship.

{{CLAUDE_RESPONSE_BLOCK}}
</task>

<compact_output_contract>
Return a compact final answer. Your first line must be exactly one of:
- ALLOW: <short reason>
- BLOCK: <short reason>
Do not put anything before that line.
</compact_output_contract>

<grounding_rules>
Verify repository context before blocking. Ground each blocking claim in inspected files or tool output. Do not block based on edits from older turns.
</grounding_rules>

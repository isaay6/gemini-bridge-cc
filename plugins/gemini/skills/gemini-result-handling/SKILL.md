---
name: gemini-result-handling
description: Internal guidance for presenting Gemini helper output back to the user
user-invocable: false
---

# Gemini Result Handling

- Preserve verdicts, summaries, findings, evidence, and next steps from helper output.
- Present review findings first, ordered by severity, and preserve reported paths and line numbers exactly.
- Keep inferences, uncertainty, and follow-up questions distinct from observed facts.
- State explicitly when there are no findings or when files were edited, if the helper reports that information.
- After a review, ask which findings the user wants fixed before making any edits.
- For a failed rescue run, report the actionable failure and stop; do not substitute an independent implementation.
- If setup or sign-in is required, direct the user to `/gemini:setup`.

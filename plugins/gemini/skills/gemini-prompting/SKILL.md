---
name: gemini-prompting
description: Internal guidance for composing clear Gemini prompts for coding, review, diagnosis, and research through agy
user-invocable: false
---

# Gemini Prompting

Write direct, compact prompts for agy.

- State one explicit task and the intended outcome.
- Name relevant files, directories, failures, or constraints.
- Say what verification command to run when work changes code.
- For read-only work, explicitly say: "Do not modify files."
- Specify the desired output shape when it matters, such as findings, diagnosis, changed files, or verification results.
- Ground review and research requests in repository evidence; distinguish facts from hypotheses.
- Avoid unrelated requests and remove redundant instructions before sending the prompt.

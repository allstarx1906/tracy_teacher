# Agent workflow

- Codex leads planning, orchestration, and reporting.
- Cursor CLI with explicit `--model composer-2.5` is the only application-source writer in development worktrees.
- Codex reviewers inspect independently and must never modify files.
- Use `scripts/Invoke-MultiAgent.ps1`; keep writers sequential and use isolated Git worktrees.
- Maximum two review/fix rounds; a final review after the second fix never triggers another fix.
- Never automatically commit, push, merge, delete worktrees, access production databases, or bypass permissions.
- Preserve all existing instructions. Ask before destructive actions.
- Reviewer role instructions alone are not a security boundary. Automated review starts a separate Codex process with `--sandbox read-only`, and its subagent inherits that sandbox.

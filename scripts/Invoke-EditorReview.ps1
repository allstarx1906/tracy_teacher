param([Parameter(Mandatory)][string]$RunId, [int]$Round = 0)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if ($RunId -notmatch '^\d{8}-\d{6}-[a-f0-9]{8}$' -or $Round -lt 0 -or $Round -gt 2) { throw 'Invalid review identity.' }
$run = Join-Path $repo ".orchestration/runs/$RunId"
$report = Get-Content (Join-Path $run 'report.json') -Raw | ConvertFrom-Json
$worktree = $report.worktree
$before = Join-Path $run 'before'
$env:CODEX_HOME = 'C:\Users\allst\.codex'
$prompt = @"
Strictly read-only coordinator. Spawn exactly ONE independent native Codex reviewer, wait for completion, and report its findings. Neither parent nor child may write files or run mutations. Review current application source in this worktree against original before snapshot at $before (untracked orphan files: ordinary git diff insufficient). Current user task ACCOUNTS_TASK: real local Node backend accounts and teacher-created student accounts, forced password change, secure session lifecycle and server-enforced role/object authorisation. Inspect server.mjs, server modules, client, tests, documentation and integration with existing editor. Check CSRF/session/password/reset/disable/bootstrap, data projection/IDOR including images and unpublished grading, student payload tampering/immutable versions/server timestamps, legacy migration integrity, auth state cleanup/stale async callbacks, route guards, account UI end-to-end. Check tests independently using temporary dirs only if feasible, no persistent data writes or source changes. Report actionable concrete bugs or missing core requirements with reproduction/path/line/priority, not speculative hardening. Do not re-report unrelated preexisting editor/backup issues. Return reviewer_spawned true only if child actually ran; verdict pass/issues/blocked and findings strings.
"@
& codex exec --sandbox read-only -c 'approval_policy="never"' --enable multi_agent -C $worktree --output-schema (Join-Path $repo 'orchestration/review.schema.json') -o (Join-Path $run "review-$Round.json") $prompt *> (Join-Path $run "review-$Round.log")
$reviewExit = $LASTEXITCODE
@{exitCode=$reviewExit;round=$Round;sandbox='read-only'} | ConvertTo-Json | Set-Content (Join-Path $run "review-$Round.execution.json")
exit $reviewExit

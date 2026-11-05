param([Parameter(Mandatory)][string]$RunId,[Parameter(Mandatory)][string]$BaselineRunId,[ValidateRange(0,2)][int]$Round=0)
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
foreach($identity in @($RunId,$BaselineRunId)){if($identity -notmatch '^\d{8}-\d{6}-[a-f0-9]{8}$'){throw 'Invalid run'}}
$run=Join-Path $repo ".orchestration/runs/$RunId"
$report=Get-Content (Join-Path $run 'report.json') -Raw|ConvertFrom-Json
$baseline=Join-Path $repo ".orchestration/runs/$BaselineRunId/before"
$prompt=@"
Read-only coordinator. Spawn exactly ONE independent native Codex reviewer inheriting read-only sandbox, wait for completion. Neither process may modify files. Review additive BA MVPv1.2 implementation against baseline $baseline, in worktree $($report.worktree). Read root orchestration/BA_MVP_v1.2.txt and orchestration/BA_IMPLEMENT_TASK.txt. Full orphan untracked files require direct snapshot compare not ordinary git diff. Inspect ALL F01-F08 BR01-BR24 AC01-AC24, actual UI/server integration not helpers alone. Verify compatibility existing classes/students/accounts/homework/editor, migration no userdata loss, authoritative memberships old/new editing, teacher-only APIs/projections/CSRF/stale auth, interval1:1 overlap and recurrence/timezones/idempotency, session lifecycle/audits/attendance corrections/revision conflicts/reports math, durable reminders overdue/restart/cancelrevision/concurrent processing, recipients/sessiontime snapshots/dedupe/missinginfo, deterministic mock honest labels/retryhistory/manualindependence, usable responsive forms/busy/dirty/retry/newedits. Do not invent scope outside agreed BA. Concrete reproducible missing core features count as findings. Map incompleteACs honestly; no pass if routes/screens fake or major requiredflows missing. Inspect tests independently read-only no persistent stores/sourcewrites; executable in-memory tests allowed if no writes. Return JSON reviewer_spawned true only if native child ran, verdict pass/issues/blocked, findings priority/path/line/repro. Limit duplicate issues and state real validation limits.
"@
& codex exec --sandbox read-only -c 'approval_policy="never"' --enable multi_agent -C $report.worktree --output-schema (Join-Path $repo 'orchestration/review.schema.json') -o (Join-Path $run "ba-review-$Round.json") $prompt *> (Join-Path $run "ba-review-$Round.log")
$reviewExit=$LASTEXITCODE
@{exitCode=$reviewExit;round=$Round;sandbox='read-only'}|ConvertTo-Json|Set-Content (Join-Path $run "ba-review-$Round.execution.json")
exit $reviewExit

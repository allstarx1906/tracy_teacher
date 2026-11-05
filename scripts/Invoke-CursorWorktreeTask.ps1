[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$WorktreeId,
    [Parameter(Mandatory)][string]$TaskFile,
    [switch]$UnlimitedFixCycles
)
$ErrorActionPreference = 'Stop'
$repo = (& git -C $PSScriptRoot rev-parse --show-toplevel).Trim()
if ($WorktreeId -notmatch '^\d{8}-\d{6}-[a-f0-9]{8}$') { throw 'Invalid isolated worktree ID.' }
$worktree = Join-Path $repo ".orchestration/worktrees/$WorktreeId"
if (-not (Test-Path -LiteralPath (Join-Path $worktree '.git'))) { throw 'Existing isolated worktree required.' }
$task = Get-Content -LiteralPath $TaskFile -Raw
$runId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8)
$run = Join-Path $repo ".orchestration/runs/$runId"
New-Item -ItemType Directory -Path $run | Out-Null
$TimeoutSeconds = 900
$TestCommand = @('node --test tests','node --check dist/app.js','node --check dist/model.js','node --check server.mjs')
$report = [ordered]@{runId=$runId;worktree=$worktree;cursorModel='composer-2.5';status='running';executions=@();tests=@();reviews=@();changedFiles=@();maxFixCycles=2}
if ($UnlimitedFixCycles) { $report.maxFixCycles = $null; $report.userAuthorizedUnlimitedFixCycles = $true }
$orchestrationScriptsRoot = $PSScriptRoot
$errors = $null
$tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Invoke-MultiAgent.ps1'),[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Orchestration parse failed.' }
foreach ($name in @('Save-Report','Fingerprint','Invoke-WorktreeGit','Run-Tool','Snapshot','Validate')) {
    $function = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
    . ([scriptblock]::Create($function.Extent.Text.Replace('$PSScriptRoot','$orchestrationScriptsRoot')))
}
$lock = [IO.File]::Open((Join-Path $repo '.orchestration/orchestrator.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {
    $before = Join-Path $run 'before'
    New-Item -ItemType Directory -Path $before | Out-Null
    Copy-Item -LiteralPath (Join-Path $worktree 'dist') -Destination $before -Recurse
    Copy-Item -LiteralPath (Join-Path $worktree 'tests') -Destination $before -Recurse
    foreach ($entry in @('server.mjs','package.json','server')) {
        $source = Join-Path $worktree $entry
        if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $before -Recurse }
    }
    (Fingerprint) | Set-Content (Join-Path $run 'before.sha256.txt')
    $prompt = "You are the only application-source writer in this isolated worktree. Follow AGENTS.md. Do not commit, push, merge, deploy, access production databases, modify orchestration files, or bypass permissions. Implement this focused follow-up task, preserve existing data and completed features. Run checks if permitted; orchestrator runs them if denied. Task:`n$task"
    $result = Run-Tool 'cursor-initial' (Get-Command agent).Source @('--model','composer-2.5','-p','--output-format','text','--workspace',$worktree,'--trust',$prompt)
    Snapshot 'result'
    if ($result.exitCode -ne 0) { throw 'Cursor execution failed.' }
    if (-not (Validate 'result')) { throw 'Validation failed.' }
    (Fingerprint) | Set-Content (Join-Path $run 'after.sha256.txt')
    $report.status = 'awaiting-independent-review'
} catch {
    $report.status = 'blocked'
    $report.error = $_.Exception.Message
    Write-Warning $_.Exception.Message
} finally {
    Save-Report
    $lock.Dispose()
    Write-Host "Report: $(Join-Path $run 'report.json')"
    Write-Host "Status: $($report.status)"
}
if ($report.status -eq 'blocked') { exit 1 }

param([string]$Payload)
$ErrorActionPreference = 'Stop'
$p = Get-Content -LiteralPath $Payload -Raw | ConvertFrom-Json
Set-Location -LiteralPath $p.cwd
$invokeArgs = @($p.arguments)
if ([IO.Path]::GetFileName($Payload) -like 'cursor-fix-*.input.json') {
    $qaPath = Join-Path (Split-Path -Parent $Payload) 'LEAD_QA_CHECKLIST.md'
    if (Test-Path -LiteralPath $qaPath) {
        $invokeArgs[$invokeArgs.Count - 1] += "`nLead browser QA evidence (verify and address alongside independent review):`n" + (Get-Content -LiteralPath $qaPath -Raw)
    }
}
$ErrorActionPreference = 'Continue'
& $p.tool @invokeArgs
if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }
if (-not $?) { exit 1 }

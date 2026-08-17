<#
  dev-down.ps1 - cleanly stop everything scripts/dev-up.ps1 started:
  the two dev-server terminal windows (apps/api, apps/web) and the
  docker compose services.
#>

$ErrorActionPreference = 'Continue'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$DevDir = Join-Path $RepoRoot '.dev'
$PidFile = Join-Path $DevDir 'pids.json'

function Stop-ProcessTree {
    param([int]$ProcessId, [string]$Label)

    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $proc) {
        Write-Host "  $Label (PID $ProcessId) is not running." -ForegroundColor DarkGray
        return
    }

    Write-Host "  Stopping $Label (PID $ProcessId)..."
    # /T kills the whole tree (the terminal window + pnpm + the actual nest/next
    # child process it spawned) - killing just the window PID leaves the server running.
    taskkill /PID $ProcessId /T /F 2>&1 | Out-Null
}

if (Test-Path $PidFile) {
    $recordedPids = Get-Content $PidFile -Raw | ConvertFrom-Json

    Write-Host "1/2 Stopping dev server windows..." -ForegroundColor Cyan
    if ($recordedPids.apiPid) { Stop-ProcessTree -ProcessId $recordedPids.apiPid -Label 'apps/api' }
    if ($recordedPids.webPid) { Stop-ProcessTree -ProcessId $recordedPids.webPid -Label 'apps/web' }

    Remove-Item $PidFile -Force
} else {
    Write-Host "1/2 No $PidFile found - no dev servers recorded as started by dev-up.ps1." -ForegroundColor Yellow
}

Write-Host "2/2 Stopping Docker services (Postgres + Mailhog)..." -ForegroundColor Cyan
Push-Location $RepoRoot
try {
    docker compose down
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "Environment stopped" -ForegroundColor Green

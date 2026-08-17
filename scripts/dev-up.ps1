<#
  dev-up.ps1 - fully automatic local dev bring-up, cold-machine safe.

  1. Confirms Docker Desktop's engine is reachable, starting it if needed.
  2. docker compose up -d, then polls until postgres + mailhog are actually healthy/running.
  3. Kills any stale process on ports 4000 (api), 3000 (web), 5555 (prisma studio) - unconditional, every run.
  4. Starts apps/api's dev server in its own visible terminal window, polls :4000/health.
  5. Starts apps/web's dev server in its own visible terminal window, polls :3000.
  6. Prints "EVERYTHING IS READY" only once all of the above are genuinely confirmed.

  -Clean additionally deletes apps/web/.next before starting (stale build cache recovery).

  PIDs of the two spawned terminal windows are recorded in .dev/pids.json so
  dev-down.ps1 can stop exactly what this script started.
#>

param(
    [switch]$Clean
)

# 'Continue', not 'Stop': this script shells out to docker/netstat/taskkill
# constantly, and under 'Stop' a native command's own stderr output (even
# routine, non-fatal output) gets wrapped as a terminating NativeCommandError
# and kills the script. Every native call below checks $LASTEXITCODE / return
# values explicitly instead of relying on exceptions.
$ErrorActionPreference = 'Continue'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$DevDir = Join-Path $RepoRoot '.dev'
$PidFile = Join-Path $DevDir 'pids.json'
$ApiLog = Join-Path $DevDir 'api.log'
$WebLog = Join-Path $DevDir 'web.log'

$ApiHealthUrl = 'http://localhost:4000/health'
$WebUrl = 'http://localhost:3000'
$ApiPort = 4000
$WebPort = 3000
$StudioPort = 5555

if (-not (Test-Path $DevDir)) {
    New-Item -ItemType Directory -Path $DevDir | Out-Null
}

function Write-Step($text) {
    Write-Host ""
    Write-Host $text -ForegroundColor Cyan
}

function Write-Ok($text) {
    Write-Host "  [OK] $text" -ForegroundColor Green
}

function Write-Fail($text) {
    Write-Host "  [FAIL] $text" -ForegroundColor Red
}

# ---------------------------------------------------------------------------
# -Clean: nuke apps/web/.next before doing anything else
# ---------------------------------------------------------------------------
if ($Clean) {
    Write-Step "0/6 -Clean: removing apps/web/.next"
    $nextDir = Join-Path $RepoRoot 'apps\web\.next'
    if (Test-Path $nextDir) {
        Remove-Item -Recurse -Force $nextDir
        Write-Ok "removed $nextDir"
    } else {
        Write-Ok "$nextDir did not exist, nothing to remove"
    }
}

# ---------------------------------------------------------------------------
# 1. Docker Desktop engine reachable? Start it if not, poll up to 90s.
# ---------------------------------------------------------------------------
Write-Step "1/6 Checking Docker Desktop engine..."

function Test-DockerEngineUp {
    docker info *> $null
    return ($LASTEXITCODE -eq 0)
}

if (Test-DockerEngineUp) {
    Write-Ok "Docker engine already reachable"
} else {
    Write-Host "  Docker engine not reachable - attempting 'docker desktop start'..."
    try {
        docker desktop start *> $null
    } catch {
        # Plugin may not exist on this install - fall through to polling anyway,
        # in case Docker Desktop is already mid-launch from a manual start.
    }

    $deadline = (Get-Date).AddSeconds(90)
    $up = $false
    while ((Get-Date) -lt $deadline) {
        if (Test-DockerEngineUp) { $up = $true; break }
        Start-Sleep -Seconds 3
    }

    if (-not $up) {
        Write-Fail "Docker engine did not come up within 90 seconds."
        Write-Host ""
        Write-Host "  Open Docker Desktop manually, wait for it to finish starting, then re-run this script." -ForegroundColor Yellow
        exit 1
    }
    Write-Ok "Docker engine is up"
}

# ---------------------------------------------------------------------------
# 2. docker compose up -d, then poll until postgres + mailhog are healthy/running
# ---------------------------------------------------------------------------
Write-Step "2/6 Starting docker compose services (postgres, mailhog)..."

Push-Location $RepoRoot
try {
    docker compose up -d
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose up -d failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

function Get-ContainerReadyState {
    param([string]$ContainerId)
    if (-not $ContainerId) { return $false }
    $stateJson = docker inspect --format '{{json .State}}' $ContainerId 2>$null
    if (-not $stateJson) { return $false }
    $state = $stateJson | ConvertFrom-Json
    if ($state.Health) {
        return ($state.Health.Status -eq 'healthy')
    }
    # No healthcheck defined for this service (e.g. mailhog) - running is the best signal available.
    return ($state.Status -eq 'running')
}

function Wait-ForComposeService {
    param([string]$Service, [int]$TimeoutSeconds)
    Push-Location $RepoRoot
    try {
        $containerId = (docker compose ps -q $Service 2>$null | Select-Object -First 1)
    } finally {
        Pop-Location
    }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        Push-Location $RepoRoot
        try {
            if (-not $containerId) {
                $containerId = (docker compose ps -q $Service 2>$null | Select-Object -First 1)
            }
        } finally {
            Pop-Location
        }
        if (Get-ContainerReadyState -ContainerId $containerId) { return $true }
        Start-Sleep -Seconds 2
    }
    return $false
}

$postgresUp = Wait-ForComposeService -Service 'postgres' -TimeoutSeconds 60
if ($postgresUp) { Write-Ok "postgres healthy" } else { Write-Fail "postgres did not become healthy in time"; exit 1 }

$mailhogUp = Wait-ForComposeService -Service 'mailhog' -TimeoutSeconds 60
if ($mailhogUp) { Write-Ok "mailhog running" } else { Write-Fail "mailhog did not come up in time"; exit 1 }

# ---------------------------------------------------------------------------
# 3. Kill stale processes on 4000 / 3000 / 5555, unconditionally, every run.
# ---------------------------------------------------------------------------
Write-Step "3/6 Clearing stale processes on ports 4000, 3000, 5555..."

function Stop-StaleProcessOnPort {
    param([int]$Port)

    $lines = netstat -ano | Select-String -Pattern "(?im)^\s*TCP\s+\S*:$Port\s+.*LISTENING\s+(\d+)\s*$"
    $pidsToKill = @()
    foreach ($line in $lines) {
        $pidsToKill += $line.Matches[0].Groups[1].Value
    }
    $pidsToKill = $pidsToKill | Sort-Object -Unique

    if ($pidsToKill.Count -eq 0) {
        Write-Host "  port $Port : nothing listening"
        return
    }

    foreach ($stalePid in $pidsToKill) {
        Write-Host "  port $Port : killing stale PID $stalePid"
        taskkill /PID $stalePid /F *> $null
    }
}

Stop-StaleProcessOnPort -Port $ApiPort
Stop-StaleProcessOnPort -Port $WebPort
Stop-StaleProcessOnPort -Port $StudioPort
Write-Ok "ports cleared"

# ---------------------------------------------------------------------------
# Shared: poll a URL until it responds 2xx
# ---------------------------------------------------------------------------
function Wait-ForUrl {
    param([string]$Url, [string]$Label, [int]$TimeoutSeconds)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
                return $true
            }
        } catch {
            # not up yet - retry until deadline
        }
        Start-Sleep -Seconds 2
    }
    return $false
}

# ---------------------------------------------------------------------------
# 4. apps/api dev server, own visible terminal, poll /health
# ---------------------------------------------------------------------------
Write-Step "4/6 Starting apps/api dev server (new window)..."

$apiWindowCmd = "`$host.UI.RawUI.WindowTitle = 'digital-billing: api (start:dev)'; Set-Location '$RepoRoot'; pnpm --filter @digital-billing/api run start:dev 2>&1 | Tee-Object -FilePath '$ApiLog'"
$apiProcess = Start-Process -FilePath 'powershell.exe' `
    -ArgumentList '-NoExit', '-NoProfile', '-Command', $apiWindowCmd `
    -PassThru

Write-Host "  window opened (PID $($apiProcess.Id)), waiting for http://localhost:4000/health..."
$apiUp = Wait-ForUrl -Url $ApiHealthUrl -Label 'apps/api' -TimeoutSeconds 60
if ($apiUp) { Write-Ok "apps/api responding on :4000/health" } else {
    Write-Fail "apps/api did not respond within 60s - check its terminal window / $ApiLog"
    exit 1
}

# ---------------------------------------------------------------------------
# 5. apps/web dev server, own visible terminal, poll root
# ---------------------------------------------------------------------------
Write-Step "5/6 Starting apps/web dev server (new window)..."

$webWindowCmd = "`$host.UI.RawUI.WindowTitle = 'digital-billing: web (dev)'; Set-Location '$RepoRoot'; pnpm --filter @digital-billing/web run dev 2>&1 | Tee-Object -FilePath '$WebLog'"
$webProcess = Start-Process -FilePath 'powershell.exe' `
    -ArgumentList '-NoExit', '-NoProfile', '-Command', $webWindowCmd `
    -PassThru

Write-Host "  window opened (PID $($webProcess.Id)), waiting for http://localhost:3000..."
$webUp = Wait-ForUrl -Url $WebUrl -Label 'apps/web' -TimeoutSeconds 60
if ($webUp) { Write-Ok "apps/web responding on :3000" } else {
    Write-Fail "apps/web did not respond within 60s - check its terminal window / $WebLog"
    exit 1
}

# Record the two terminal-window PIDs for dev-down.ps1
@{ apiPid = $apiProcess.Id; webPid = $webProcess.Id } | ConvertTo-Json | Set-Content -Path $PidFile

# ---------------------------------------------------------------------------
# 6. Ready
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host " EVERYTHING IS READY" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host "  App           : http://localhost:3000"
Write-Host "  API health    : http://localhost:4000/health"
Write-Host "  Mailhog UI    : http://localhost:8025"
Write-Host "  Prisma Studio : pnpm --filter @digital-billing/api exec prisma studio"
Write-Host ""
Write-Host "  Run 'pnpm dev:down' to stop everything." -ForegroundColor DarkGray

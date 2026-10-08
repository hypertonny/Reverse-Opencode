# ==============================================================================
# Reverse-Opencode Gateway: Universal Launcher (v1.0.0)
# Author: Hypertonny
# ==============================================================================

param (
    [switch]$Launch = $false,
    [string]$Model = "sonnet 5.5"
)

$ErrorActionPreference = "SilentlyContinue"
$ProjectRoot = $PSScriptRoot

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "       REVERSE-OPENCODE GATEWAY LAUNCHER (v1.0.0)          " -ForegroundColor Cyan
Write-Host "                   Author: Hypertonny                      " -ForegroundColor DarkGray
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# ------------------------------------------------------------------------------
# 1. Check or Start OpenCode Headless Server (Port 4096)
# ------------------------------------------------------------------------------
$opencodeListener = Get-NetTCPConnection -LocalPort 4096 -State Listen -ErrorAction SilentlyContinue
if ($null -eq $opencodeListener) {
    Write-Host "[*] Starting OpenCode server (port 4096) in background..." -ForegroundColor Yellow
    Start-Process -FilePath "opencode" -ArgumentList "serve --port 4096" -WorkingDirectory $ProjectRoot -WindowStyle Hidden
    Start-Sleep -Seconds 2
} else {
    Write-Host "[OK] OpenCode server is already running on port 4096." -ForegroundColor Green
}

# ------------------------------------------------------------------------------
# 2. Check or Start Reverse-Opencode Gateway (Port 3005)
# ------------------------------------------------------------------------------
$proxyListener = Get-NetTCPConnection -LocalPort 3005 -State Listen -ErrorAction SilentlyContinue
if ($null -eq $proxyListener) {
    Write-Host "[*] Starting Proxy Gateway on port 3005 in background..." -ForegroundColor Yellow
    Start-Process -FilePath "bun" -ArgumentList "run src/index.ts" -WorkingDirectory $ProjectRoot -WindowStyle Hidden
    Start-Sleep -Seconds 2
} else {
    Write-Host "[OK] Proxy Gateway is already running on port 3005." -ForegroundColor Green
}

# ------------------------------------------------------------------------------
# 3. Health Check & Upstream Verification
# ------------------------------------------------------------------------------
Write-Host "[*] Verifying gateway health..." -ForegroundColor Yellow
$retries = 10
$healthy = $false

for ($i = 0; $i -lt $retries; $i++) {
    try {
        $res = Invoke-RestMethod -Uri "http://127.0.0.1:3005/health" -Method Get -TimeoutSec 2 -ErrorAction Stop
        if ($res.ok -eq $true -and $res.upstream -eq "connected") {
            $healthy = $true
            break
        }
    } catch {
        Start-Sleep -Milliseconds 800
    }
}

if (-not $healthy) {
    Write-Host "[!] Gateway failed to report healthy within 10s." -ForegroundColor Red
    Write-Host "    Check logs at: $ProjectRoot\logs\requests.jsonl" -ForegroundColor Red
    exit 1
}

# ------------------------------------------------------------------------------
# 4. Display Configuration & Credentials Card
# ------------------------------------------------------------------------------
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "                  GATEWAY IS LIVE & READY                   " -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  URL:    " -NoNewline -ForegroundColor Cyan; Write-Host "http://127.0.0.1:3005" -ForegroundColor White
Write-Host "  Token:  " -NoNewline -ForegroundColor Cyan; Write-Host "dummy" -ForegroundColor White
Write-Host "  Model:  " -NoNewline -ForegroundColor Cyan; Write-Host "$Model (or opus 5.5 / muse-spark-1.3-contributor-free)" -ForegroundColor White
Write-Host ""
Write-Host "------------------------------------------------------------" -ForegroundColor DarkGray
Write-Host "  To configure Claude Code manually in any PowerShell terminal:" -ForegroundColor Yellow
Write-Host '  $env:ANTHROPIC_BASE_URL = "http://127.0.0.1:3005"' -ForegroundColor White
Write-Host '  $env:ANTHROPIC_API_KEY  = "dummy"' -ForegroundColor White
Write-Host "  claude --model `"$Model`"" -ForegroundColor White
Write-Host "------------------------------------------------------------" -ForegroundColor DarkGray
Write-Host ""

# ------------------------------------------------------------------------------
# 5. Interactive Launch Option
# ------------------------------------------------------------------------------
$shouldLaunch = $Launch

if (-not $shouldLaunch) {
    $prompt = Read-Host "Would you like to launch Claude Code right now in this window? (Y/n)"
    if ($prompt -eq "" -or $prompt -match "^[yY]") {
        $shouldLaunch = $true
    }
}

if ($shouldLaunch) {
    Write-Host ""
    Write-Host "[*] Launching Claude Code with model '$Model'..." -ForegroundColor Cyan
    $env:CLAUDE_CONFIG_DIR = "$HOME\.claude"
    $env:ANTHROPIC_BASE_URL = "http://127.0.0.1:3005"
    $env:ANTHROPIC_API_KEY = "dummy"
    & claude --model "$Model"
}

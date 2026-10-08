# ==============================================================================
# Reverse-Opencode Gateway: Shutdown Script (v1.0.0)
# Author: Hypertonny
# ==============================================================================

Write-Host ""
Write-Host "============================================================" -ForegroundColor Yellow
Write-Host "          STOPPING REVERSE-OPENCODE GATEWAY SERVICES        " -ForegroundColor Yellow
Write-Host "============================================================" -ForegroundColor Yellow
Write-Host ""

# Stop Proxy Gateway on port 3005
$proxyConn = Get-NetTCPConnection -LocalPort 3005 -State Listen -ErrorAction SilentlyContinue
if ($proxyConn) {
    $proxyPids = $proxyConn | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($p in $proxyPids) {
        Write-Host "[*] Stopping Proxy Gateway (PID $p)..." -ForegroundColor Yellow
        Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
    }
    Write-Host "[OK] Proxy Gateway stopped." -ForegroundColor Green
} else {
    Write-Host "[-] Proxy Gateway (port 3005) is not running." -ForegroundColor DarkGray
}

# Stop OpenCode server on port 4096
$opencodeConn = Get-NetTCPConnection -LocalPort 4096 -State Listen -ErrorAction SilentlyContinue
if ($opencodeConn) {
    $opencodePids = $opencodeConn | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($p in $opencodePids) {
        Write-Host "[*] Stopping OpenCode Server (PID $p)..." -ForegroundColor Yellow
        Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
    }
    Write-Host "[OK] OpenCode Server stopped." -ForegroundColor Green
} else {
    Write-Host "[-] OpenCode Server (port 4096) is not running." -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "[OK] All Reverse-Opencode background services are stopped." -ForegroundColor Green
Write-Host ""

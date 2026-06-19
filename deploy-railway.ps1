# Despliegue Manabí Power en Railway
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectDir

$npm = 'C:\Program Files\nodejs\npm.cmd'
$railway = Join-Path $env:APPDATA 'npm\railway.cmd'

Write-Host '=== Manabi Power - Deploy Railway ===' -ForegroundColor Cyan

if (-not (Test-Path $npm)) {
    Write-Host 'Node.js no encontrado. Instala Node LTS y vuelve a ejecutar.' -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $railway)) {
    Write-Host 'Instalando Railway CLI...'
    & $npm install -g @railway/cli
}

if (-not (Test-Path 'node_modules')) {
    Write-Host 'Instalando dependencias...'
    & $npm install
}

Write-Host ''
Write-Host '1) Inicia sesion en Railway (se abrira el navegador):' -ForegroundColor Yellow
& $railway login

Write-Host ''
Write-Host '2) Vincula este proyecto con tu servicio de manabipower.com:' -ForegroundColor Yellow
Write-Host '   Selecciona el proyecto y el servicio existente cuando te lo pida.'
& $railway link

Write-Host ''
Write-Host '3) Verifica variables (deben existir DISCORD_TOKEN y DB_CHANNEL_ID):' -ForegroundColor Yellow
& $railway variables

Write-Host ''
Write-Host '4) Desplegando...' -ForegroundColor Yellow
& $railway up --detach

Write-Host ''
Write-Host 'Listo. Abre manabipower.com y prueba la sincronizacion.' -ForegroundColor Green
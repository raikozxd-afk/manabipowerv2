# Configura variables de Discord en Railway y despliega manabipower.com
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectDir

$railway = Join-Path $env:APPDATA 'npm\railway.cmd'
$npm = 'C:\Program Files\nodejs\npm.cmd'

if (-not (Test-Path $railway)) {
    Write-Host 'Instalando Railway CLI...' -ForegroundColor Yellow
    & $npm install -g @railway/cli
}

if (-not (Test-Path '.env')) {
    Write-Host 'No se encontró .env. Configure DISCORD_TOKEN y DB_CHANNEL_ID primero.' -ForegroundColor Red
    exit 1
}

$vars = @{}
Get-Content '.env' | ForEach-Object {
    if ($_ -match '^\s*([^#=]+)=(.*)$') {
        $vars[$matches[1].Trim()] = $matches[2].Trim()
    }
}

$required = @('DISCORD_TOKEN', 'DB_CHANNEL_ID')
foreach ($key in $required) {
    if (-not $vars[$key] -or $vars[$key] -match '^tu_|^id_del_') {
        Write-Host "Falta configurar $key en .env" -ForegroundColor Red
        exit 1
    }
}

Write-Host '=== Railway: verificar sesion ===' -ForegroundColor Cyan
& $railway whoami 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Inicie sesion en Railway (se abrira el navegador)...' -ForegroundColor Yellow
    & $railway login
}

Write-Host '=== Railway: verificar proyecto vinculado ===' -ForegroundColor Cyan
& $railway status 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Vincule el servicio de manabipower.com cuando se le pida.' -ForegroundColor Yellow
    & $railway link
}

Write-Host '=== Railway: configurar variables ===' -ForegroundColor Cyan
& $railway variable set "DISCORD_TOKEN=$($vars['DISCORD_TOKEN'])" --skip-deploys
& $railway variable set "DB_CHANNEL_ID=$($vars['DB_CHANNEL_ID'])" --skip-deploys
if ($vars['AUTH_ADMIN_PASS']) { & $railway variable set "AUTH_ADMIN_PASS=$($vars['AUTH_ADMIN_PASS'])" --skip-deploys }
if ($vars['AUTH_SCRUT_PASS']) { & $railway variable set "AUTH_SCRUT_PASS=$($vars['AUTH_SCRUT_PASS'])" --skip-deploys }
if ($vars['AUTH_JUDGE_PASS']) { & $railway variable set "AUTH_JUDGE_PASS=$($vars['AUTH_JUDGE_PASS'])" --skip-deploys }
if ($vars['LOG_CHANNEL_ID']) { & $railway variable set "LOG_CHANNEL_ID=$($vars['LOG_CHANNEL_ID'])" --skip-deploys }

Write-Host '=== Railway: desplegar ===' -ForegroundColor Cyan
& $railway up --detach

Write-Host ''
Write-Host 'Listo. Espere 1-2 minutos y abra https://manabipower.com' -ForegroundColor Green
Write-Host 'Verifique: https://manabipower.com/api/status' -ForegroundColor Green
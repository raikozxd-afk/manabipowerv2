# Organiza y verifica el canal de Discord para Manabi Power
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectDir

$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) {
    Write-Host 'Node.js no encontrado. Instale Node LTS.' -ForegroundColor Red
    exit 1
}

if (-not (Test-Path '.env')) {
    Write-Host 'Cree .env con DISCORD_TOKEN y DB_CHANNEL_ID (copie de .env.example).' -ForegroundColor Red
    exit 1
}

if (-not (Test-Path 'node_modules')) {
    Write-Host 'Instalando dependencias...' -ForegroundColor Yellow
    & 'C:\Program Files\nodejs\npm.cmd' install
}

& $node scripts/organize-discord.js
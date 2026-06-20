# Crea canales de texto organizados en el servidor Discord de Manabi Power
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)

$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) {
    Write-Host 'Instale Node.js LTS.' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path '.env')) {
    Write-Host 'Configure .env con DISCORD_TOKEN y DB_CHANNEL_ID.' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path 'node_modules')) {
    & 'C:\Program Files\nodejs\npm.cmd' install
}

& $node scripts/setup-discord-channels.js
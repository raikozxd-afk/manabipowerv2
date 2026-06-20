@echo off
title Manabi Power - Servidor + Discord
cd /d "%~dp0"
echo.
echo  Manabi Power V3 - Mesa de Control
echo  Servidor: http://localhost:3000
echo  Discord: sincronizacion en tiempo real
echo.
start "" "http://localhost:3000"
node index.js
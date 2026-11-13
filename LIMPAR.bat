@echo off
title Limpar pasta antes de enviar
cd /d "%~dp0"

echo Removendo pastas pesadas que nao precisam ir no zip...
for %%P in (node_modules .output .tanstack .wrangler) do (
  if exist "%%P" (
    rmdir /s /q "%%P"
    echo   - %%P removida
  )
)
if exist ".git" (
  rmdir /s /q ".git"
  echo   - .git removida
)

echo.
echo Pronto! Agora e so zipar a pasta e mandar.
pause

@echo off
title Deploy Vercel - Funil
cd /d "%~dp0"

echo ============================================
echo   Deploy do funil para a Vercel
echo ============================================
echo.
echo Na primeira vez vai pedir:
echo   1. Login na Vercel (abra o link / aperte uma tecla no navegador)
echo   2. Confirmar o projeto (responda tudo com Enter / Y)
echo.
echo Nas proximas vezes e so apertar qualquer tecla e esperar.
echo.
pause

where vercel >nul 2>nul
if errorlevel 1 (
  echo Instalando o CLI da Vercel...
  call npm install -g vercel
)

call vercel --prod --yes

echo.
echo ============================================
echo   Pronto! A URL de producao aparece acima.
echo ============================================
pause

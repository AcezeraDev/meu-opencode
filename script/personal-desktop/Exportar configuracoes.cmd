@echo off
rem Dois cliques: cria o arquivo com as suas configuracoes do OpenCode Personal na Area de Trabalho.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0exportar.ps1"

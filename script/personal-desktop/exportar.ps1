# Cria o arquivo com as suas configurações do OpenCode Personal, para levar a
# outro PC (lá, o instalar.ps1 pede esse arquivo).
#
#   Dois cliques em "Exportar configuracoes.cmd", nesta mesma pasta.
#
# O arquivo sai na Área de Trabalho, protegido pela senha que você escolher.
# Ele tem as suas chaves de API e logins: leve por pendrive, Google Drive ou
# WhatsApp para você mesmo, mas nunca coloque no GitHub.

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8

$raiz = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun) { throw "Não achei o Bun neste PC." }

Write-Host ""
Write-Host "Exportar as configurações do OpenCode Personal" -ForegroundColor Cyan
Write-Host "Leva: configuração, agentes, skills, chaves de API e logins, preferências do app"
Write-Host "e, se você quiser, o histórico de conversas."
Write-Host ""

$argumentos = @("script/personal-desktop/export.ts")
$historico = Read-Host "Levar também o histórico de conversas? (S/n)"
if ($historico -match "^[nN]") { $argumentos += "--sem-historico" }

function Ler-Senha([string]$pergunta) {
  $segura = Read-Host $pergunta -AsSecureString
  return [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($segura))
}

while ($true) {
  $senha = Ler-Senha "Escolha uma senha (mínimo 8 caracteres)"
  if ($senha.Length -lt 8) { Write-Host "Curta demais." -ForegroundColor Yellow; continue }
  if ((Ler-Senha "Digite a senha de novo") -ne $senha) { Write-Host "As senhas não conferem." -ForegroundColor Yellow; continue }
  break
}

$env:OPENCODE_PACK_SENHA = $senha
Push-Location $raiz
try {
  & $bun.Source @argumentos
  if ($LASTEXITCODE -ne 0) { throw "A exportação falhou." }
} finally {
  Pop-Location
  Remove-Item Env:OPENCODE_PACK_SENHA -ErrorAction SilentlyContinue
}

$saida = Get-ChildItem ([Environment]::GetFolderPath("Desktop")) -Filter "OpenCode-configuracoes-*.ocpack" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($saida) { Start-Process explorer.exe "/select,`"$($saida.FullName)`"" }

Write-Host ""
Write-Host "No outro PC, abra o PowerShell e rode:" -ForegroundColor Green
Write-Host "  irm https://raw.githubusercontent.com/AcezeraDev/meu-opencode/dev/script/personal-desktop/instalar.ps1 | iex" -ForegroundColor White
Write-Host ""
Read-Host "Enter para fechar"

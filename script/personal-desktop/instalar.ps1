# Instala o OpenCode Personal num PC novo, baixando o app JÁ PRONTO.
#
# Num PowerShell comum (não precisa de administrador):
#
#   irm https://raw.githubusercontent.com/AcezeraDev/meu-opencode/dev/script/personal-desktop/instalar.ps1 | iex
#
# O que ele faz, na ordem:
#   1. baixa da GitHub Release o instalador pronto e duas ferramentas pequenas
#   2. instala o app (segundos, não compila nada)
#   3. restaura o arquivo de configurações (.ocpack) que você exportou no outro PC
#   4. agenda a atualização automática (baixa a Release nova quando aparecer)
#   5. abre o app e mostra como ligar a extensão do Brave
#
# NÃO precisa de Git, Bun, compilador nem do código-fonte. Pode rodar de novo
# quando quiser: reinstala por cima com a versão mais nova.
#
# Para já apontar o arquivo de configurações, defina antes:
#   $env:OPENCODE_PACOTE = "C:\Users\voce\Desktop\OpenCode-configuracoes.ocpack"
#
# (Sem bloco param: rodado por "irm | iex" ele chega com um BOM na frente, que o
# param não aceita, e sem o BOM o PowerShell 5.1 estraga os acentos ao abrir.)

$Repo = "AcezeraDev/meu-opencode"
$Tag = "personal-latest"
$Base = "https://github.com/$Repo/releases/download/$Tag"
$Casa = Join-Path $env:LOCALAPPDATA "OpenCodePersonal"
$AppExe = Join-Path $env:LOCALAPPDATA "Programs\opencode-personal\OpenCode Personal.exe"
$Pacote = if ($env:OPENCODE_PACOTE) { $env:OPENCODE_PACOTE } else { "" }

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocol]::Tls12 } catch {}

function Etapa([string]$t) { Write-Host ""; Write-Host "==> $t" -ForegroundColor Cyan }
function Aviso([string]$t) { Write-Host "    $t" -ForegroundColor Yellow }
function Ok([string]$t) { Write-Host "    $t" -ForegroundColor Green }
function Falha([string]$t) {
  Write-Host ""; Write-Host "ERRO: $t" -ForegroundColor Red
  Write-Host "Nada foi desfeito; corrija e rode o instalador de novo." -ForegroundColor Red
  throw $t
}

function Baixar([string]$url, [string]$destino) {
  Write-Host "    baixando $(Split-Path $destino -Leaf)..."
  $tmp = "$destino.part"
  try {
    $wc = New-Object Net.WebClient
    $wc.DownloadFile($url, $tmp)
  } catch {
    # Alguns ambientes bloqueiam o WebClient; tenta o Invoke-WebRequest.
    Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
  }
  if (-not (Test-Path $tmp) -or (Get-Item $tmp).Length -eq 0) { Falha "Download vazio: $url" }
  Move-Item -Force $tmp $destino
}

New-Item -ItemType Directory -Force $Casa | Out-Null

# ------------------------------------------------------------------ 1. baixar
Etapa "Baixando o OpenCode Personal (instalador pronto, ~130 MB)"
$Setup = Join-Path $Casa "OpenCodePersonalSetup.exe"
$Importador = Join-Path $Casa "opencode-import.exe"
$Atualizador = Join-Path $Casa "opencode-atualizar.exe"
$Versao = Join-Path $Casa "version.json"
Baixar "$Base/OpenCodePersonalSetup.exe" $Setup
Baixar "$Base/opencode-import.exe" $Importador
Baixar "$Base/opencode-atualizar.exe" $Atualizador
Baixar "$Base/version.json" $Versao
Ok "Baixado."

# ------------------------------------------------------------------ 2. instalar
Etapa "Instalando (segundos)"
Get-Process "OpenCode Personal" -ErrorAction SilentlyContinue | ForEach-Object {
  Aviso "Fechando o app aberto para instalar..."
  $_.CloseMainWindow() | Out-Null; Start-Sleep -Seconds 3
}
# /S = silencioso; sem --force-run, para não abrir o app antes de importar.
& $Setup /S | Out-Host
$fim = (Get-Date).AddMinutes(2)
while (-not (Test-Path $AppExe) -and (Get-Date) -lt $fim) { Start-Sleep -Seconds 2 }
if (-not (Test-Path $AppExe)) { Falha "O instalador rodou mas o app não apareceu em $AppExe." }
Ok "Instalado."

# ------------------------------------------------------------------ 3. configurações
Etapa "Suas configurações"
if (-not $Pacote) {
  $resposta = Read-Host "    Você tem o arquivo de configurações (.ocpack) do outro PC? (S/n)"
  if ($resposta -notmatch "^[nN]") {
    Add-Type -AssemblyName System.Windows.Forms
    $dialogo = New-Object System.Windows.Forms.OpenFileDialog
    $dialogo.Title = "Escolha o arquivo de configurações do OpenCode"
    $dialogo.Filter = "Configurações do OpenCode (*.ocpack)|*.ocpack|Todos os arquivos (*.*)|*.*"
    $dialogo.InitialDirectory = [Environment]::GetFolderPath("Desktop")
    if ($dialogo.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) { $Pacote = $dialogo.FileName }
  }
}
if ($Pacote) {
  if (-not (Test-Path $Pacote)) { Falha "Arquivo não encontrado: $Pacote" }
  $importado = $false
  for ($t = 1; $t -le 3 -and -not $importado; $t++) {
    $segura = Read-Host "    Senha do arquivo" -AsSecureString
    $env:OPENCODE_PACK_SENHA = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
      [Runtime.InteropServices.Marshal]::SecureStringToBSTR($segura))
    try { & $Importador $Pacote | Out-Host; $importado = ($LASTEXITCODE -eq 0) }
    finally { Remove-Item Env:OPENCODE_PACK_SENHA -ErrorAction SilentlyContinue }
    if (-not $importado -and $t -lt 3) { Aviso "Não deu certo; tente a senha de novo." }
  }
  if (-not $importado) { Falha "Não consegui abrir o arquivo de configurações." }
  Ok "Configurações importadas."
} else {
  Aviso "Sem arquivo: o app começa com o padrão. Dá para importar depois com:"
  Aviso "  $Importador <arquivo.ocpack>"
}

# ------------------------------------------------------------------ 4. atualização automática
# Este PC segue as Releases: um atualizador leve confere o GitHub e, quando há
# versão nova, baixa e instala (só com o app fechado). Sem código, sem compilar.
Etapa "Deixando o app se atualizar sozinho"
try {
  $commit = (Get-Content $Versao -Raw | ConvertFrom-Json).commit
  $versaoTxt = (Get-Content $Versao -Raw | ConvertFrom-Json).version
} catch { $commit = ""; $versaoTxt = "" }
$marcador = @{ commit = $commit; version = $versaoTxt; installedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
[IO.File]::WriteAllText((Join-Path $Casa "release.json"), ($marcador | ConvertTo-Json))

# Um lançador .vbs roda o atualizador escondido (sem piscar janela de console).
$vbs = Join-Path $Casa "atualizar.vbs"
$conteudoVbs = 'Set s = CreateObject("WScript.Shell")' + "`r`n" + 's.Run Chr(34) & "' + $Atualizador + '" & Chr(34), 0, False'
[IO.File]::WriteAllText($vbs, $conteudoVbs, [Text.Encoding]::ASCII)
$nomeTarefa = "OpenCode Personal - Atualizar"
try {
  $acao = New-ScheduledTaskAction -Execute "wscript.exe" -Argument ('"' + $vbs + '"')
  $gLogon = New-ScheduledTaskTrigger -AtLogOn
  $gPeriodo = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 6)
  Register-ScheduledTask -TaskName $nomeTarefa -Action $acao -Trigger $gLogon, $gPeriodo -Force | Out-Null
  Ok "Confere o GitHub ao ligar o PC e a cada 6 horas."
} catch {
  # Fallback para o schtasks se o módulo ScheduledTasks não estiver disponível.
  & schtasks /Create /TN $nomeTarefa /TR "wscript.exe `"$vbs`"" /SC ONLOGON /F | Out-Null
  Ok "Confere o GitHub ao ligar o PC."
}

# ------------------------------------------------------------------ 5. abrir + Brave
Etapa "Abrindo o OpenCode Personal"
Start-Process $AppExe

$brave = @(
  "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe",
  "${env:ProgramFiles(x86)}\BraveSoftware\Brave-Browser\Application\brave.exe",
  "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

Etapa "Extensão do Brave (para a IA mexer no seu navegador)"
if (-not $brave) {
  $resposta = Read-Host "    O Brave não está instalado. Instalar agora? (S/n)"
  if (($resposta -notmatch "^[nN]") -and (Get-Command winget -ErrorAction SilentlyContinue)) {
    & winget install --id Brave.Brave -e --silent --accept-source-agreements --accept-package-agreements | Out-Host
    $brave = "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe"
  }
}
$extensao = Join-Path $env:LOCALAPPDATA "Programs\opencode-personal\resources\browser-extension"
Write-Host "    A extensão vem dentro do app. Para ligar:"
Write-Host "      1. Em brave://extensions, ligue 'Modo do desenvolvedor' (canto de cima)."
Write-Host "      2. 'Carregar sem compactação' e escolha a pasta:"
Write-Host "         $extensao" -ForegroundColor White
Write-Host "      3. No OpenCode, abra o painel do navegador (ícone do globo): ele mostra a"
Write-Host "         porta e o código; coloque os dois no ícone da extensão, no Brave."
if ($brave -and (Test-Path $brave)) { Start-Process $brave "brave://extensions" }
if (Test-Path $extensao) { Start-Process explorer.exe $extensao }

Write-Host ""
Write-Host "Pronto! O OpenCode Personal está instalado em $AppExe" -ForegroundColor Green
Write-Host "Atualizações e registro em $Casa" -ForegroundColor Green

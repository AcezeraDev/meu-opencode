# Instala o Lynx Code num PC novo, baixando o app JÁ PRONTO.
#
# Num PowerShell comum (não precisa de administrador):
#
#   irm https://raw.githubusercontent.com/AcezeraDev/meu-opencode/dev/script/personal-desktop/instalar.ps1 | iex
#
# O que ele faz, na ordem:
#   1. baixa da GitHub Release o instalador pronto e o importador de configurações
#   2. instala o app (segundos, não compila nada)
#   3. restaura o arquivo de configurações (.ocpack) que você exportou no outro PC
#   4. abre o app e mostra como ligar a extensão do Brave
#
# Depois disso o próprio app se atualiza: cada build do PC principal sobe sozinho
# para a Release, e aqui aparece o botão Atualizar → Reiniciar na barra de título
# (baixa só o que mudou). Sem tarefa agendada, sem rodar este script de novo.
#
# NÃO precisa de Git, Bun, compilador nem do código-fonte. Pode rodar de novo
# quando quiser (por exemplo, para importar configurações mais novas).
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
$AppExe = Join-Path $env:LOCALAPPDATA "Programs\opencode-personal\Lynx Code.exe"
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
Etapa "Baixando o Lynx Code (instalador pronto, ~160 MB)"
$Setup = Join-Path $Casa "OpenCodePersonalSetup.exe"
$Importador = Join-Path $Casa "opencode-import.exe"
Baixar "$Base/OpenCodePersonalSetup.exe" $Setup
Baixar "$Base/opencode-import.exe" $Importador
Ok "Baixado."

# Instalações antigas tinham uma tarefa agendada que baixava o instalador
# inteiro a cada 6 h. Agora o app se atualiza sozinho; a tarefa sai.
Unregister-ScheduledTask -TaskName "OpenCode Personal - Atualizar" -Confirm:$false -ErrorAction SilentlyContinue
foreach ($velho in "opencode-atualizar.exe", "atualizar.vbs", "release.json", "version.json") {
  Remove-Item (Join-Path $Casa $velho) -Force -ErrorAction SilentlyContinue
}

# ------------------------------------------------------------------ 2. instalar
Etapa "Instalando (segundos)"
Get-Process "Lynx Code", "OpenCode Personal" -ErrorAction SilentlyContinue | ForEach-Object {
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

# ------------------------------------------------------------------ 4. programas
# Funções que dependem de programas do Windows. Nada é instalado sem perguntar.
function Existe([string]$comando) {
  $achado = Get-Command $comando -ErrorAction SilentlyContinue | Select-Object -First 1
  # O "python" da pasta WindowsApps só abre a Microsoft Store; não é o Python.
  return [bool]$achado -and ($achado.Source -notlike "*\WindowsApps\*")
}
$temWinget = [bool](Get-Command winget -ErrorAction SilentlyContinue)
function Garantir([string]$nome, [string]$comando, [string]$id, [string]$para) {
  if (Existe $comando) { Ok "${nome}: já instalado"; return }
  Aviso "$nome não está instalado (serve para $para)."
  if (-not $temWinget) { Aviso "  Instale pelo site oficial do $nome e rode este instalador de novo."; return }
  $resposta = Read-Host "    Instalar o $nome agora? (S/n)"
  if ($resposta -match "^[nN]") { return }
  & winget install --id $id -e --silent --accept-source-agreements --accept-package-agreements | Out-Host
  # Esta janela não enxerga o programa recém-instalado até reler o PATH.
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}
Etapa "Programas que algumas funções usam"
Garantir "Git" "git" "Git.Git" "desfazer alterações da IA, comparar mudanças e trabalhar em cópias separadas do projeto"
Garantir "Python" "python" "Python.Python.3.12" "as skills que criam Word, PowerPoint, Excel e PDF"

# ------------------------------------------------------------------ 5. abrir + Brave
Etapa "Abrindo o Lynx Code"
# O importador grava as chaves como variáveis do usuário, que esta janela ainda
# não tem; sem isto o app abriria sem elas até o próximo login no Windows.
foreach ($nome in [Environment]::GetEnvironmentVariables("User").Keys) {
  if ($nome -match "(_API_KEY|_TOKEN)$|^OPENCODE_BROWSER_") {
    Set-Item "Env:$nome" ([Environment]::GetEnvironmentVariable($nome, "User"))
  }
}
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

# ------------------------------------------------------------------ 6. conferir
Etapa "Conferindo se está tudo no lugar"
$script:faltou = 0
function Item([string]$nome, [bool]$certo, [string]$dica) {
  if ($certo) { Write-Host "    [ok] $nome" -ForegroundColor Green; return }
  Write-Host "    [  ] $nome" -ForegroundColor Yellow
  if ($dica) { Write-Host "         $dica" }
  $script:faltou++
}
$cfg = Join-Path $HOME ".config\opencode"
$dados = Join-Path $HOME ".local\share\opencode"
$semPacote = "Vem no arquivo .ocpack: & `"$Importador`" <arquivo.ocpack> (com o app fechado)"
$versao = (Get-Item $AppExe).VersionInfo.ProductVersion
Item "App instalado (versão $versao)" (Test-Path $AppExe) ""
Item "Extensão do Brave dentro do app" (Test-Path (Join-Path $extensao "manifest.json")) "O instalador veio sem ela; rode este instalador de novo mais tarde."
Item "Brave" ([bool]$brave -and (Test-Path "$brave")) "Instale o Brave para a IA usar o seu navegador."
Item "Configurações (provedores, navegador, papéis dos modelos)" ((Test-Path "$cfg\opencode.jsonc") -or (Test-Path "$cfg\opencode.json")) $semPacote
Item "Contas e logins" (Test-Path "$dados\auth.json") $semPacote
$pastas = @("$cfg\skills", "$HOME\.claude\skills", "$HOME\.agents\skills") | Where-Object { Test-Path $_ }
$skills = ($pastas | ForEach-Object { @(Get-ChildItem $_ -Directory -Force).Count } | Measure-Object -Sum).Sum
Item "Skills ($([int]$skills))" ($skills -gt 0) $semPacote
$chaves = @([Environment]::GetEnvironmentVariables("User").Keys | Where-Object { $_ -match "(_API_KEY|_TOKEN)$" })
Item "Chaves de API ($($chaves.Count))" ($chaves.Count -gt 0) "$semPacote. Se você não usa nenhuma chave, ignore."
Item "Git" (Existe "git") "Rode este instalador de novo e aceite instalar o Git."
Item "Python" (Existe "python") "Rode este instalador de novo e aceite instalar o Python."

Write-Host ""
if ($script:faltou -eq 0) {
  Write-Host "Pronto! O Lynx Code está completo neste PC, em $AppExe" -ForegroundColor Green
} else {
  Write-Host "O Lynx Code está instalado em $AppExe." -ForegroundColor Green
  Write-Host "Falta(m) $($script:faltou) item(ns) acima; o resto já funciona." -ForegroundColor Yellow
}
Write-Host "Ele se atualiza sozinho: quando houver versão nova, use o botão Atualizar na barra de título." -ForegroundColor Green

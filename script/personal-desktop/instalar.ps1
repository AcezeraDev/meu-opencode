# Instala o OpenCode Personal num PC novo, com as suas configurações.
#
# Num PowerShell comum (não precisa de administrador):
#
#   irm https://raw.githubusercontent.com/AcezeraDev/meu-opencode/dev/script/personal-desktop/instalar.ps1 | iex
#
# O que ele faz, na ordem:
#   1. instala o Git e o Bun, se faltarem (pelo winget)
#   2. baixa o código do GitHub para %USERPROFILE%\opencode
#   3. instala as dependências
#   4. restaura o arquivo de configurações (.ocpack) que você exportou no outro PC
#   5. compila e instala o app (uns 10 minutos na primeira vez)
#   6. deixa o app se atualizando sozinho a partir do GitHub
#   7. abre o app e mostra como ligar a extensão do Brave
#
# Pode rodar de novo quando quiser: o que já estiver pronto é pulado.
#
# Para mudar a pasta ou já apontar o arquivo de configurações, defina antes:
#   $env:OPENCODE_PASTA = "D:\opencode"
#   $env:OPENCODE_PACOTE = "C:\Users\voce\Desktop\OpenCode-configuracoes.ocpack"
#
# (Sem bloco param: rodado por "irm | iex" ele chega com um BOM na frente, que o
# param não aceita, e sem o BOM o PowerShell 5.1 estraga os acentos ao abrir o
# arquivo. Variáveis servem aos dois jeitos.)

$Pasta = if ($env:OPENCODE_PASTA) { $env:OPENCODE_PASTA } else { Join-Path $env:USERPROFILE "opencode" }
$Pacote = if ($env:OPENCODE_PACOTE) { $env:OPENCODE_PACOTE } else { "" }
$Repositorio = "https://github.com/AcezeraDev/meu-opencode.git"
$Branch = "dev"

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8

function Etapa([string]$texto) { Write-Host ""; Write-Host "==> $texto" -ForegroundColor Cyan }
function Aviso([string]$texto) { Write-Host "    $texto" -ForegroundColor Yellow }
function Ok([string]$texto) { Write-Host "    $texto" -ForegroundColor Green }

function Falha([string]$texto) {
  Write-Host ""
  Write-Host "ERRO: $texto" -ForegroundColor Red
  Write-Host "Nada foi desfeito; corrija e rode o instalador de novo, ele continua de onde parou." -ForegroundColor Red
  throw $texto
}

# Programas instalados agora só aparecem no PATH de terminais novos; este lê de novo.
function Atualizar-Path {
  $maquina = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $usuario = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$maquina;$usuario;$env:USERPROFILE\.bun\bin"
}

function Rodar([string]$programa, [string[]]$argumentos, [string]$onde = $PWD.Path) {
  Push-Location $onde
  try {
    & $programa @argumentos
    if ($LASTEXITCODE -ne 0) { Falha "'$programa $($argumentos -join ' ')' terminou com código $LASTEXITCODE." }
  } finally { Pop-Location }
}

function Tem([string]$programa) { return [bool](Get-Command $programa -ErrorAction SilentlyContinue) }

function Instalar-Com-Winget([string]$id, [string]$nome) {
  if (-not (Tem "winget")) {
    Falha "Não achei o winget para instalar o $nome. Instale o 'Instalador de Aplicativo' pela Microsoft Store e rode de novo."
  }
  Write-Host "    instalando o $nome..."
  & winget install --id $id -e --silent --accept-source-agreements --accept-package-agreements | Out-Host
  Atualizar-Path
}

# ------------------------------------------------------------------ 1. programas
Etapa "Conferindo Git e Bun"
Atualizar-Path
if (Tem "git") { Ok "Git já instalado." } else { Instalar-Com-Winget "Git.Git" "Git" }
if (-not (Tem "git")) { Falha "O Git não ficou disponível. Feche este PowerShell, abra outro e rode de novo." }

if (Tem "bun") { Ok "Bun já instalado." } else {
  Instalar-Com-Winget "Oven-sh.Bun" "Bun"
  if (-not (Tem "bun")) {
    Aviso "O winget não deixou o Bun no PATH; usando o instalador oficial."
    Invoke-RestMethod "https://bun.sh/install.ps1" | Invoke-Expression
    Atualizar-Path
  }
}
if (-not (Tem "bun")) { Falha "O Bun não ficou disponível. Feche este PowerShell, abra outro e rode de novo." }
$Bun = (Get-Command bun).Source

# ------------------------------------------------------------------ 2. código
Etapa "Baixando o código"
# O gerador do instalador (NSIS) não abre caminhos com mais de 260 letras, e o
# mais fundo das dependências tem ~140 além da pasta do código.
if ($Pasta.Length -gt 100) {
  Falha "A pasta $Pasta tem um caminho longo demais para compilar. Use uma mais curta, como C:\opencode (defina `$env:OPENCODE_PASTA)."
}
if (Test-Path (Join-Path $Pasta ".git")) {
  Ok "Já existe em $Pasta; mantendo (as atualizações vêm depois, pelo próprio app)."
} else {
  if ((Test-Path $Pasta) -and (Get-ChildItem $Pasta -Force | Select-Object -First 1)) {
    Falha "A pasta $Pasta já existe e não está vazia. Use outra: -Pasta C:\algum\lugar"
  }
  Rodar "git" @("clone", "--branch", $Branch, $Repositorio, $Pasta)
}

# ------------------------------------------------------------------ 3. dependências
Etapa "Instalando dependências (alguns minutos)"
Rodar $Bun @("install") $Pasta
Rodar $Bun @("script/personal-desktop/links.ts") $Pasta

# ------------------------------------------------------------------ 4. configurações
Etapa "Suas configurações"
if (-not $Pacote) {
  $resposta = Read-Host "    Você tem o arquivo de configurações (.ocpack) exportado do outro PC? (S/n)"
  if ($resposta -notmatch "^[nN]") {
    Add-Type -AssemblyName System.Windows.Forms
    $dialogo = New-Object System.Windows.Forms.OpenFileDialog
    $dialogo.Title = "Escolha o arquivo de configurações do OpenCode"
    $dialogo.Filter = "Configurações do OpenCode (*.ocpack)|*.ocpack|Todos os arquivos (*.*)|*.*"
    $dialogo.InitialDirectory = [Environment]::GetFolderPath("Desktop")
    if ($dialogo.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $Pacote = $dialogo.FileName }
  }
}
if ($Pacote) {
  if (-not (Test-Path $Pacote)) { Falha "Arquivo não encontrado: $Pacote" }
  $importado = $false
  for ($tentativa = 1; $tentativa -le 3 -and -not $importado; $tentativa++) {
    $segura = Read-Host "    Senha do arquivo" -AsSecureString
    $env:OPENCODE_PACK_SENHA = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
      [Runtime.InteropServices.Marshal]::SecureStringToBSTR($segura))
    Push-Location $Pasta
    try { & $Bun "script/personal-desktop/import.ts" $Pacote | Out-Host; $importado = ($LASTEXITCODE -eq 0) }
    finally { Pop-Location; Remove-Item Env:OPENCODE_PACK_SENHA -ErrorAction SilentlyContinue }
    if (-not $importado -and $tentativa -lt 3) { Aviso "Não deu certo; tente a senha de novo." }
  }
  if (-not $importado) { Falha "Não consegui abrir o arquivo de configurações." }
  Atualizar-Path
} else {
  Aviso "Sem arquivo: o app vai começar com as configurações padrão. Dá para importar depois com:"
  Aviso "  cd $Pasta; bun script/personal-desktop/import.ts <arquivo.ocpack>"
}

# ------------------------------------------------------------------ 5. seguir o GitHub
# Este PC recebe as mudanças que forem publicadas no GitHub, em vez de ser onde
# elas são feitas: o vigia e o botão Atualizar do app puxam de lá.
$estado = Join-Path $env:LOCALAPPDATA "OpenCodePersonal"
New-Item -ItemType Directory -Force $estado | Out-Null
$seguir = Join-Path $estado "follow.json"
[IO.File]::WriteAllText($seguir, (@{ remote = "origin"; branch = $Branch } | ConvertTo-Json))

# ------------------------------------------------------------------ 6. compilar e instalar
Etapa "Compilando e instalando o OpenCode Personal (uns 10 minutos na primeira vez)"
$app = Join-Path $env:LOCALAPPDATA "Programs\opencode-personal\OpenCode Personal.exe"
Get-Process "OpenCode Personal" -ErrorAction SilentlyContinue | ForEach-Object {
  Aviso "Fechando o OpenCode Personal para instalar a versão nova..."
  $_.CloseMainWindow() | Out-Null
  Start-Sleep -Seconds 3
}
Rodar $Bun @("script/personal-desktop/update.ts", "--force") $Pasta
if (-not (Test-Path $app)) { Falha "A compilação terminou, mas o app não apareceu em $app. Veja $estado\update.log" }
Ok "Instalado."

# ------------------------------------------------------------------ 7. atualizações automáticas
Etapa "Deixando o app se atualizar sozinho"
Rodar $Bun @("script/personal-desktop/startup.ts") $Pasta
Ok "A cada 20 minutos, e sempre que o Windows iniciar, ele confere o GitHub."
Ok "O botão Atualizar do app também puxa de lá."

# ------------------------------------------------------------------ 8. abrir e ligar o Brave
Etapa "Abrindo o OpenCode Personal"
Start-Process $app

$brave = @(
  "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe",
  "${env:ProgramFiles(x86)}\BraveSoftware\Brave-Browser\Application\brave.exe",
  "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

Etapa "Extensão do Brave (para a IA mexer no seu navegador)"
if (-not $brave) {
  $resposta = Read-Host "    O Brave não está instalado. Instalar agora? (S/n)"
  if ($resposta -notmatch "^[nN]") {
    Instalar-Com-Winget "Brave.Brave" "Brave"
    $brave = "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe"
    if (-not (Test-Path $brave)) { $brave = "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe" }
  }
}
$extensao = Join-Path $Pasta "browser-extension"
Write-Host "    O Brave só aceita extensões assim por um clique seu:"
Write-Host "      1. Em brave://extensions, ligue 'Modo do desenvolvedor' (canto de cima)."
Write-Host "      2. Clique em 'Carregar sem compactação' e escolha a pasta:"
Write-Host "         $extensao" -ForegroundColor White
Write-Host "      3. No OpenCode, abra o painel do navegador (ícone do globo): ele mostra a porta"
Write-Host "         e o código. Coloque os dois no ícone da extensão, no Brave."
if ($brave -and (Test-Path $brave)) { Start-Process $brave "brave://extensions" }
Start-Process explorer.exe $extensao

Write-Host ""
Write-Host "Pronto! O OpenCode Personal está instalado em $app" -ForegroundColor Green
Write-Host "Código em $Pasta; registro das atualizações em $estado\update.log" -ForegroundColor Green

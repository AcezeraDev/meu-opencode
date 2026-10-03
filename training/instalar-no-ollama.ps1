# Instala a Ghost treinada no Ollama deste PC.
#
# Uso (PowerShell, na pasta onde está o arquivo .gguf):
#   powershell -ExecutionPolicy Bypass -File instalar-no-ollama.ps1 -Arquivo ghost-1-q8_0.gguf
#   ... -Nome ghost:2 -Base qwen3.5:2b      (próximas versões; a base tem que ser a mesma usada no treino)
#
# Copia do modelo base o jeito de conversar (RENDERER/PARSER do Qwen3.5, que é o
# que faz as ferramentas funcionarem), troca só o arquivo do modelo e cria o novo
# nome no Ollama. Depois ele aparece no opencode como ollama/<nome>.

param(
  [Parameter(Mandatory = $true)][string]$Arquivo,
  [string]$Nome = "ghost:1",
  [string]$Base = "qwen3.5:2b"
)

$ErrorActionPreference = "Stop"
$gguf = (Resolve-Path $Arquivo).Path
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) { throw "O Ollama não está instalado ou não está no PATH." }

Write-Host "Lendo o formato de conversa de $Base..."
$original = ollama show $Base --modelfile 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Baixando $Base (só para copiar o formato de conversa)..."
  ollama pull $Base
  $original = ollama show $Base --modelfile
}

# Tudo do Modelfile original, menos a linha FROM, que passa a apontar para o seu arquivo.
$linhas = $original | Where-Object { $_ -notmatch '^\s*FROM\s' -and $_ -notmatch '^\s*#' }
$modelfile = @("FROM `"$gguf`"") + $linhas
$destino = Join-Path (Split-Path $gguf) "Modelfile"
[System.IO.File]::WriteAllLines($destino, $modelfile, (New-Object System.Text.UTF8Encoding $false))

Write-Host "Criando $Nome no Ollama..."
ollama create $Nome -f $destino
if ($LASTEXITCODE -ne 0) { throw "O Ollama não conseguiu criar $Nome. Veja a mensagem acima." }

Write-Host "Testando (a primeira resposta demora enquanto o modelo carrega)..."
# Pela API: o PowerShell 5.1 trata a animação que o "ollama run" escreve como erro.
# ReadAllText, não Get-Content -Raw: no PowerShell 5.1 este vira {"value": ...} no JSON.
$arquivoIdentidade = Join-Path $PSScriptRoot "identidade.md"
$identidade = if (Test-Path $arquivoIdentidade) { [System.IO.File]::ReadAllText($arquivoIdentidade, [System.Text.Encoding]::UTF8) } else { "" }
$mensagens = @()
if ($identidade) { $mensagens += @{ role = "system"; content = $identidade } }
$mensagens += @{ role = "user"; content = "Responda em uma frase: quem é você?" }
$corpo = @{ model = $Nome; stream = $false; think = $false; messages = $mensagens; options = @{ num_predict = 80 } } | ConvertTo-Json -Depth 5
$bytes = [System.Text.Encoding]::UTF8.GetBytes($corpo)
$resposta = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/chat" -Method Post -Body $bytes -ContentType "application/json; charset=utf-8" -TimeoutSec 900
Write-Host $resposta.message.content
Write-Host ""
Write-Host "Pronto: $Nome está no Ollama. No opencode ele aparece como ollama/$Nome (recarregue o projeto ou reinicie o app)."

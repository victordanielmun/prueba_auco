<#
.SYNOPSIS
  Levanta el stack con Docker Compose y valida el servicio de punta a punta.

.DESCRIPTION
  1. Comprueba Docker y crea .env desde .env.example si falta.
  2. docker compose up (MongoDB + DynamoDB Local + API) y espera a que /health responda.
  3. Genera un JWT HS256 (o usa -Token), crea una validacion, la consulta y prueba los errores 400/401/404.
  4. Consulta DynamoDB Local por documento (sin AWS CLI) y muestra los eventos de auditoria.
  Sale con codigo 0 si todo pasa y 1 si algo falla.

.EXAMPLE
  .\scripts\start-and-validate.ps1
  .\scripts\start-and-validate.ps1 -NoBuild          # reutiliza la imagen existente
  .\scripts\start-and-validate.ps1 -Down             # apaga el stack al terminar
#>
param(
  [string]$BaseUrl = "http://localhost:3000",
  [string]$DynamoEndpoint = "http://localhost:8000",
  [string]$AuditTable = "validation_audit_events",
  [string]$Token = "",
  [string]$JwtSecret = "",
  [int]$StartupTimeoutSec = 120,
  [switch]$NoBuild,
  [switch]$Down
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
$script:Passed = 0
$script:Failed = 0

# ---------- salida ----------
function Write-Step([string]$Msg) { Write-Host "`n==> $Msg" -ForegroundColor Cyan }
function Write-Ok([string]$Msg)   { Write-Host "[PASS] $Msg" -ForegroundColor Green }
function Write-Warn([string]$Msg) { Write-Host "[WARN] $Msg" -ForegroundColor Yellow }

function Assert-That([string]$Name, [bool]$Condition, [string]$Detail = "") {
  if ($Condition) {
    $script:Passed++
    Write-Ok $Name
  } else {
    $script:Failed++
    Write-Host "[FAIL] $Name" -ForegroundColor Red -NoNewline
    if ($Detail) { Write-Host "  -> $Detail" -ForegroundColor DarkYellow } else { Write-Host "" }
  }
}

# ---------- utilidades ----------
function Read-DotEnvValue([string]$Name) {
  $envFile = Join-Path $RepoRoot ".env"
  if (-not (Test-Path $envFile)) { return $null }
  $line = Get-Content $envFile | Where-Object { $_ -match "^\s*$Name\s*=" } | Select-Object -First 1
  if ($line) { return ($line -split "=", 2)[1].Trim().Trim('"') }
  return $null
}

function ConvertTo-Base64Url([byte[]]$Bytes) {
  [Convert]::ToBase64String($Bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function New-Jwt([string]$Secret, [int]$ExpiresInSeconds = 600) {
  $enc = [System.Text.Encoding]::UTF8
  $exp = [DateTimeOffset]::UtcNow.AddSeconds($ExpiresInSeconds).ToUnixTimeSeconds()
  $unsigned = (ConvertTo-Base64Url $enc.GetBytes('{"alg":"HS256","typ":"JWT"}')) + "." +
              (ConvertTo-Base64Url $enc.GetBytes('{"sub":"start-and-validate","exp":' + $exp + '}'))
  $hmac = New-Object System.Security.Cryptography.HMACSHA256 (, $enc.GetBytes($Secret))
  return $unsigned + "." + (ConvertTo-Base64Url ($hmac.ComputeHash($enc.GetBytes($unsigned))))
}

# Devuelve Status/Body/Raw tanto en 2xx como en 4xx/5xx (PowerShell 5.1 y 7).
function Invoke-Api {
  param([string]$Method, [string]$Url, [hashtable]$Headers = @{}, [string]$Body, [string]$ContentType = "application/json", [int]$TimeoutSec = 10)
  $params = @{ Method = $Method; Uri = $Url; Headers = $Headers; UseBasicParsing = $true; TimeoutSec = $TimeoutSec }
  if ($Body) { $params.Body = $Body; $params.ContentType = $ContentType }
  try {
    $r = Invoke-WebRequest @params
    $status = [int]$r.StatusCode
    if ($r.Content -is [byte[]]) { $text = [System.Text.Encoding]::UTF8.GetString($r.Content) } else { $text = $r.Content }
  } catch {
    $resp = $_.Exception.Response
    if (-not $resp) { throw }
    $status = [int]$resp.StatusCode
    $text = $_.ErrorDetails.Message
    if (-not $text -and $resp.GetResponseStream) { $text = (New-Object System.IO.StreamReader $resp.GetResponseStream()).ReadToEnd() }
  }
  $json = $null
  if ($text) { try { $json = $text | ConvertFrom-Json } catch { $json = $null } }
  [pscustomobject]@{ Status = $status; Body = $json; Raw = $text }
}

Write-Host "==========================================================" -ForegroundColor Magenta
Write-Host "   AI VALIDATION SERVICE - START, SMOKE & AUDIT TEST       " -ForegroundColor Magenta
Write-Host "==========================================================" -ForegroundColor Magenta

# 1. Prerrequisitos
Write-Step "Checking prerequisites..."
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw "Docker no esta instalado o no esta en el PATH." }
& docker info *> $null
if ($LASTEXITCODE -ne 0) { throw "El daemon de Docker no responde. Abre Docker Desktop e intentalo de nuevo." }
Write-Ok "Docker disponible"

Set-Location $RepoRoot
if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Warn ".env no existia: se creo a partir de .env.example"
}

try {
  # 2. Levantar el stack
  Write-Step "Starting stack with docker compose (MongoDB + DynamoDB Local + API)..."
  $composeArgs = @("compose", "up", "-d")
  if (-not $NoBuild) { $composeArgs += "--build" }
  & docker @composeArgs
  if ($LASTEXITCODE -ne 0) { throw "docker compose up fallo (codigo $LASTEXITCODE)." }

  Write-Step "Waiting for /health (max $StartupTimeoutSec s)..."
  $deadline = (Get-Date).AddSeconds($StartupTimeoutSec)
  $health = $null
  while ((Get-Date) -lt $deadline) {
    try {
      $health = Invoke-Api GET "$BaseUrl/health" -TimeoutSec 3
      if ($health.Status -eq 200) { break }
    } catch { $health = $null }
    Start-Sleep -Seconds 2
  }
  if (-not $health -or $health.Status -ne 200) {
    & docker compose ps
    & docker compose logs --tail 30 api
    throw "El servicio no quedo saludable en $StartupTimeoutSec s."
  }
  Write-Ok "Service healthy: $($health.Raw)"
  & docker compose ps --format "table {{.Name}}\t{{.Status}}"

  # 3. Token
  Write-Step "Preparing JWT..."
  if ([string]::IsNullOrWhiteSpace($Token)) {
    if (-not $JwtSecret) { $JwtSecret = $env:JWT_SECRET }
    if (-not $JwtSecret) { $JwtSecret = Read-DotEnvValue "JWT_SECRET" }
    if (-not $JwtSecret) { throw "Sin -Token ni JWT_SECRET (pasalo con -JwtSecret o definelo en .env)." }
    $Token = New-Jwt $JwtSecret
    Write-Ok "Token HS256 generado desde JWT_SECRET (vigencia 10 min)"
  } else {
    Write-Ok "Usando el token recibido por parametro"
  }
  $headers = @{ Authorization = "Bearer $Token" }

  # 4. Autenticacion
  Write-Step "Checking authentication..."
  $r = Invoke-Api POST "$BaseUrl/validations" -Body '{"name":"Ada","documentNumber":"AB12345"}'
  Assert-That "POST without token -> 401" ($r.Status -eq 401) "status=$($r.Status)"

  # 5. Crear validacion
  $docNumber = "DOC-$(Get-Date -Format 'yyyyMMddHHmmss')"
  $body = @{ name = "Valeria Rojas"; documentNumber = $docNumber; countryCode = "CO" } | ConvertTo-Json -Compress

  Write-Step "Sending POST /validations for document '$docNumber'..."
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $created = Invoke-Api POST "$BaseUrl/validations" -Headers $headers -Body $body
  $sw.Stop()
  Assert-That "POST /validations -> 201 in $($sw.ElapsedMilliseconds) ms" ($created.Status -eq 201) "status=$($created.Status) body=$($created.Raw)"
  $validationId = $created.Body.id
  Assert-That "Response includes id '$validationId'" ([bool]$validationId)
  Assert-That "Enriched by apicountries (origin: $($created.Body.enrichment.origin))" ($created.Body.enrichment.provider -eq "apicountries")
  Assert-That "Status is APPROVED or REVIEW ($($created.Body.status))" (@("APPROVED", "REVIEW") -contains $created.Body.status)

  # 6. Leer validacion
  Write-Step "Fetching GET /validations/$validationId..."
  $record = Invoke-Api GET "$BaseUrl/validations/$validationId" -Headers $headers
  Assert-That "GET /validations/:id -> 200 for '$($record.Body.name)' (status: $($record.Body.status))" ($record.Status -eq 200) "status=$($record.Status)"
  Write-Host ($record.Body | ConvertTo-Json -Depth 6) -ForegroundColor Gray

  # 7. Errores esperados
  Write-Step "Checking error responses..."
  $r = Invoke-Api POST "$BaseUrl/validations" -Headers $headers -Body '{"name":"A","extra":true}'
  Assert-That "Invalid body -> 400 VALIDATION_ERROR" ($r.Status -eq 400 -and $r.Body.error.code -eq "VALIDATION_ERROR") "status=$($r.Status)"
  $r = Invoke-Api GET "$BaseUrl/validations/not-a-uuid" -Headers $headers
  Assert-That "Invalid id -> 400" ($r.Status -eq 400) "status=$($r.Status)"
  $r = Invoke-Api GET "$BaseUrl/validations/$([guid]::NewGuid())" -Headers $headers
  Assert-That "Unknown id -> 404" ($r.Status -eq 404) "status=$($r.Status)"

  # 8. Auditoria en DynamoDB Local (HTTP directo, sin AWS CLI)
  Write-Step "Querying DynamoDB Local ($AuditTable) by document '$docNumber'..."
  $query = @{
    TableName                 = $AuditTable
    KeyConditionExpression    = "documentNumber = :doc"
    ExpressionAttributeValues = @{ ":doc" = @{ S = $docNumber } }
  } | ConvertTo-Json -Depth 5 -Compress
  $dynHeaders = @{
    "X-Amz-Target"  = "DynamoDB_20120810.Query"
    "X-Amz-Date"    = "20260101T000000Z"
    "Authorization" = "AWS4-HMAC-SHA256 Credential=local/20260101/us-east-1/dynamodb/aws4_request, SignedHeaders=host;x-amz-date, Signature=local"
  }
  $q = Invoke-Api POST $DynamoEndpoint -Headers $dynHeaders -Body $query -ContentType "application/x-amz-json-1.0"
  Assert-That "DynamoDB Local query -> 200" ($q.Status -eq 200) "status=$($q.Status) body=$($q.Raw)"
  $events = @($q.Body.Items | ForEach-Object {
      [pscustomobject]@{ eventTimestamp = $_.eventTimestamp.S; eventType = $_.eventType.S; status = $_.status.S; validationId = $_.validationId.S }
    })
  $types = @($events | ForEach-Object { $_.eventType })
  Assert-That "Audit event VALIDATION_CREATED stored" ($types -contains "VALIDATION_CREATED") "events=$($types -join ',')"
  Assert-That "Audit event VALIDATION_QUERIED stored" ($types -contains "VALIDATION_QUERIED") "events=$($types -join ',')"
  Assert-That "Audit events reference validation '$validationId'" (@($events | Where-Object { $_.validationId -ne $validationId }).Count -eq 0)
  Write-Host ($events | Format-Table -AutoSize | Out-String) -ForegroundColor DarkGreen
}
finally {
  if ($Down) {
    Write-Step "Stopping stack (-Down)..."
    & docker compose down
  }
}

# 9. Resumen
Write-Host ""
$total = $script:Passed + $script:Failed
if ($script:Failed -eq 0) {
  Write-Host "All checks completed successfully ($($script:Passed)/$total)." -ForegroundColor Green
  if (-not $Down) { Write-Host "Swagger: $BaseUrl/docs   |   Detener: docker compose down" -ForegroundColor Gray }
  exit 0
}
Write-Host "$($script:Failed) of $total checks failed." -ForegroundColor Red
exit 1

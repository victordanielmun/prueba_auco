<#
.SYNOPSIS
  Smoke test del servicio de validacion contra el stack levantado con Docker Compose.

.DESCRIPTION
  Genera un JWT HS256, recorre los endpoints (health, auth, POST/GET /validations, errores)
  y consulta DynamoDB Local por documento para confirmar los eventos de auditoria.
  Sale con codigo 0 si todo pasa y 1 si algo falla.

.EXAMPLE
  .\scripts\smoke-test.ps1
  .\scripts\smoke-test.ps1 -BaseUrl http://localhost:3000 -DynamoEndpoint http://localhost:8000
#>
[CmdletBinding()]
param(
  [string]$BaseUrl = 'http://localhost:3000',
  [string]$DynamoEndpoint = 'http://localhost:8000',
  [string]$AuditTable = 'validation_audit_events',
  [string]$JwtSecret,
  [switch]$SkipDynamo
)

$ErrorActionPreference = 'Stop'
$script:Passed = 0
$script:Failed = 0

# ---------- utilidades ----------
function Read-DotEnvValue([string]$Name) {
  $envFile = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
  if (-not (Test-Path $envFile)) { return $null }
  $line = Get-Content $envFile | Where-Object { $_ -match "^\s*$Name\s*=" } | Select-Object -First 1
  if ($line) { return ($line -split '=', 2)[1].Trim().Trim('"') }
  return $null
}

function ConvertTo-Base64Url([byte[]]$Bytes) {
  [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-Jwt([string]$Secret, [int]$ExpiresInSeconds = 300) {
  $header  = '{"alg":"HS256","typ":"JWT"}'
  $exp     = [DateTimeOffset]::UtcNow.AddSeconds($ExpiresInSeconds).ToUnixTimeSeconds()
  $payload = '{"sub":"smoke-test","exp":' + $exp + '}'
  $enc     = [System.Text.Encoding]::UTF8
  $unsigned = (ConvertTo-Base64Url $enc.GetBytes($header)) + '.' + (ConvertTo-Base64Url $enc.GetBytes($payload))
  $hmac = New-Object System.Security.Cryptography.HMACSHA256 (,$enc.GetBytes($Secret))
  $sig  = ConvertTo-Base64Url ($hmac.ComputeHash($enc.GetBytes($unsigned)))
  return "$unsigned.$sig"
}

# Devuelve Status y Body (objeto) tanto en 2xx como en 4xx/5xx, en PowerShell 5.1 y 7.
function Invoke-Api {
  param([string]$Method, [string]$Url, [hashtable]$Headers = @{}, [string]$Body, [string]$ContentType = 'application/json')
  $params = @{ Method = $Method; Uri = $Url; Headers = $Headers; UseBasicParsing = $true }
  if ($Body) { $params.Body = $Body; $params.ContentType = $ContentType }
  try {
    $r = Invoke-WebRequest @params
    $status = [int]$r.StatusCode
    # PowerShell 5.1 entrega bytes cuando el Content-Type no es texto (p. ej. application/x-amz-json-1.0).
    if ($r.Content -is [byte[]]) { $text = [System.Text.Encoding]::UTF8.GetString($r.Content) } else { $text = $r.Content }
  } catch {
    $resp = $_.Exception.Response
    if (-not $resp) { throw }
    $status = [int]$resp.StatusCode
    $text = $_.ErrorDetails.Message
    if (-not $text -and $resp.GetResponseStream) {
      $text = (New-Object System.IO.StreamReader $resp.GetResponseStream()).ReadToEnd()
    }
  }
  $json = $null
  if ($text) { try { $json = $text | ConvertFrom-Json } catch { $json = $null } }
  [pscustomobject]@{ Status = $status; Body = $json; Raw = $text }
}

function Assert-That([string]$Name, [bool]$Condition, [string]$Detail = '') {
  if ($Condition) {
    $script:Passed++
    Write-Host '  [PASS] ' -ForegroundColor Green -NoNewline
    Write-Host $Name
  } else {
    $script:Failed++
    Write-Host '  [FAIL] ' -ForegroundColor Red -NoNewline
    Write-Host $Name -NoNewline
    if ($Detail) { Write-Host "  -> $Detail" -ForegroundColor DarkYellow } else { Write-Host '' }
  }
}

function Write-Section([string]$Title) {
  Write-Host ''
  Write-Host "== $Title" -ForegroundColor Cyan
}

# ---------- preparacion ----------
if (-not $JwtSecret) { $JwtSecret = $env:JWT_SECRET }
if (-not $JwtSecret) { $JwtSecret = Read-DotEnvValue 'JWT_SECRET' }
if (-not $JwtSecret) { Write-Host 'JWT_SECRET no encontrado: pasalo con -JwtSecret o definelo en .env' -ForegroundColor Red; exit 1 }

$token   = New-Jwt $JwtSecret
$auth    = @{ Authorization = "Bearer $token" }
$docNum  = 'SMK' + ([guid]::NewGuid().ToString('N').Substring(0, 12).ToUpper())

Write-Host 'Validation Service - smoke test' -ForegroundColor White
Write-Host "  API:      $BaseUrl"
Write-Host "  DynamoDB: $DynamoEndpoint ($AuditTable)"
Write-Host "  Documento de prueba: $docNum"

# ---------- health ----------
Write-Section 'Health'
$r = Invoke-Api GET "$BaseUrl/health"
Assert-That 'GET /health -> 200'                          ($r.Status -eq 200) "status=$($r.Status)"
Assert-That 'MongoDB y DynamoDB reportan up'              ($r.Body.checks.mongodb -eq 'up' -and $r.Body.checks.dynamodb -eq 'up')
$r = Invoke-Api GET "$BaseUrl/docs.json"
Assert-That 'GET /docs.json (Swagger) -> 200'             ($r.Status -eq 200) "status=$($r.Status)"

# ---------- autenticacion ----------
Write-Section 'Autenticacion'
$r = Invoke-Api POST "$BaseUrl/validations" -Body '{"name":"Ada","documentNumber":"AB12345"}'
Assert-That 'POST sin token -> 401'                       ($r.Status -eq 401) "status=$($r.Status)"
$bad = @{ Authorization = 'Bearer ' + (New-Jwt 'otro-secreto-distinto-0123456789abcdef') }
$r = Invoke-Api GET "$BaseUrl/validations/$([guid]::NewGuid())" -Headers $bad
Assert-That 'Token con firma invalida -> 401'             ($r.Status -eq 401) "status=$($r.Status)"

# ---------- POST /validations ----------
Write-Section 'POST /validations'
$payload = @{ name = 'Smoke Tester'; documentNumber = $docNum; countryCode = 'co' } | ConvertTo-Json -Compress
$created = Invoke-Api POST "$BaseUrl/validations" -Headers $auth -Body $payload
Assert-That 'Crea validacion -> 201'                      ($created.Status -eq 201) "status=$($created.Status) body=$($created.Raw)"
$id = $created.Body.id
Assert-That 'Responde con id (UUID)'                      ($id -match '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$') "id=$id"
Assert-That 'documentNumber y countryCode normalizados'   ($created.Body.documentNumber -eq $docNum -and $created.Body.countryCode -eq 'CO')
Assert-That 'Enriquecimiento con provider apicountries'   ($created.Body.enrichment.provider -eq 'apicountries')
Assert-That "Estado APPROVED o REVIEW ($($created.Body.status))" (@('APPROVED', 'REVIEW') -contains $created.Body.status)

$r = Invoke-Api POST "$BaseUrl/validations" -Headers $auth -Body '{"name":"A","extra":true}'
Assert-That 'Body invalido (Zod) -> 400'                  ($r.Status -eq 400 -and $r.Body.error.code -eq 'VALIDATION_ERROR') "status=$($r.Status)"
$r = Invoke-Api POST "$BaseUrl/validations" -Headers $auth -Body '{bad json'
Assert-That 'JSON malformado -> 400'                      ($r.Status -eq 400) "status=$($r.Status)"

# ---------- GET /validations/:id ----------
Write-Section 'GET /validations/:id'
$r = Invoke-Api GET "$BaseUrl/validations/$id" -Headers $auth
Assert-That 'Consulta por id -> 200'                      ($r.Status -eq 200) "status=$($r.Status)"
Assert-That 'Devuelve el mismo registro'                  ($r.Body.id -eq $id -and $r.Body.documentNumber -eq $docNum)
$r = Invoke-Api GET "$BaseUrl/validations/no-es-un-uuid" -Headers $auth
Assert-That 'Id invalido -> 400'                          ($r.Status -eq 400) "status=$($r.Status)"
$r = Invoke-Api GET "$BaseUrl/validations/$([guid]::NewGuid())" -Headers $auth
Assert-That 'Id inexistente -> 404'                       ($r.Status -eq 404) "status=$($r.Status)"

# ---------- DynamoDB Local ----------
if (-not $SkipDynamo) {
  Write-Section 'Auditoria en DynamoDB Local (por documento)'
  $query = @{
    TableName = $AuditTable
    KeyConditionExpression = 'documentNumber = :d'
    ExpressionAttributeValues = @{ ':d' = @{ S = $docNum } }
  } | ConvertTo-Json -Depth 5 -Compress
  $dynHeaders = @{
    'X-Amz-Target'  = 'DynamoDB_20120810.Query'
    'Authorization' = 'AWS4-HMAC-SHA256 Credential=local/20260101/us-east-1/dynamodb/aws4_request, SignedHeaders=host;x-amz-date, Signature=local'
    'X-Amz-Date'    = '20260101T000000Z'
  }
  try {
    $q = Invoke-Api POST $DynamoEndpoint -Headers $dynHeaders -Body $query -ContentType 'application/x-amz-json-1.0'
    Assert-That 'Query a DynamoDB Local -> 200'           ($q.Status -eq 200) "status=$($q.Status) body=$($q.Raw)"
    $items = @($q.Body.Items)
    $types = @($items | ForEach-Object { $_.eventType.S })
    Assert-That 'Evento VALIDATION_CREATED registrado'    ($types -contains 'VALIDATION_CREATED') "eventos=$($types -join ',')"
    Assert-That 'Evento VALIDATION_QUERIED registrado'    ($types -contains 'VALIDATION_QUERIED') "eventos=$($types -join ',')"
    $sk = [string]($items | Select-Object -First 1 | ForEach-Object { $_.eventTimestamp.S })
    Assert-That 'Sort key = fecha ISO + sufijo unico'     ([bool]($sk -match '^\d{4}-\d{2}-\d{2}T[\d:.]+Z#[0-9a-f-]{36}$')) "eventTimestamp=$sk"
    foreach ($i in $items) {
      Write-Host ("    {0}  {1}  {2}" -f $i.eventTimestamp.S, $i.eventType.S, $i.status.S) -ForegroundColor DarkGray
    }
  } catch {
    Assert-That 'Consulta a DynamoDB Local' $false $_.Exception.Message
  }
}

# ---------- resumen ----------
Write-Host ''
$total = $script:Passed + $script:Failed
if ($script:Failed -eq 0) {
  Write-Host "RESULTADO: $($script:Passed)/$total pruebas OK" -ForegroundColor Green
  exit 0
}
Write-Host "RESULTADO: $($script:Failed) de $total pruebas fallaron" -ForegroundColor Red
exit 1

param(
  [string]$RepositoryDirectory = 'F:\Codex\kishpoker-site',
  [string]$FlopDirectory = 'F:\kish-gto\flop-batch-v1',
  [string]$TurnSmokeDirectory = 'F:\kish-gto\turn-batch-smoke',
  [string]$TurnDirectory = 'F:\kish-gto\turn-batch-v1',
  [ValidateRange(1, 8)]
  [int]$ThreadCount = 8
)

$ErrorActionPreference = 'Stop'
$pipelineDirectory = 'F:\kish-gto\postflop-pipeline'
$pipelineLog = Join-Path $pipelineDirectory 'pipeline.log'
$flopCheckpointPath = Join-Path $FlopDirectory 'checkpoint.json'

function Write-PipelineEvent {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Event,
    [hashtable]$Details = @{}
  )

  $record = @{
    at = [DateTime]::UtcNow.ToString('o')
    event = $Event
    processId = $PID
  }
  foreach ($entry in $Details.GetEnumerator()) {
    $record[$entry.Key] = $entry.Value
  }
  Add-Content -LiteralPath $pipelineLog -Value ($record | ConvertTo-Json -Compress) -Encoding UTF8
}

function Read-JsonFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }
  try {
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  }
  catch {
    return $null
  }
}

function Test-FlopFinished {
  $checkpoint = Read-JsonFile -Path $flopCheckpointPath
  return (
    $null -ne $checkpoint -and
    $checkpoint.completed.Count -eq 1755 -and
    $checkpoint.failures.Count -eq 0
  )
}

function Get-GtoNodeProcess {
  param([Parameter(Mandatory = $true)][string]$Pattern)
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq 'node.exe' -and $_.CommandLine -match $Pattern
    } |
    Select-Object -First 1
}

function Wait-ForProcessToExit {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  while (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
    Start-Sleep -Seconds 15
  }
}

function Invoke-LoggedNode {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Name
  )
  $stdoutPath = Join-Path $pipelineDirectory "$Name.log"
  $stderrPath = Join-Path $pipelineDirectory "$Name-error.log"
  Push-Location -LiteralPath $RepositoryDirectory
  try {
    & 'C:\Program Files\nodejs\node.exe' @Arguments 1>> $stdoutPath 2>> $stderrPath
    $nodeExitCode = $LASTEXITCODE
  }
  finally {
    Pop-Location
  }
  if ($nodeExitCode -ne 0) {
    throw "$Name failed with exit code $nodeExitCode"
  }
}

function Test-TurnBatchFinished {
  param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][int]$ExpectedFlops
  )
  $checkpoint = Read-JsonFile -Path (Join-Path $Directory 'checkpoint.json')
  return (
    $null -ne $checkpoint -and
    $checkpoint.requestedFlops -eq $ExpectedFlops -and
    $checkpoint.completed.Count -eq $ExpectedFlops -and
    $checkpoint.failures.Count -eq 0
  )
}

function Start-TurnSupervisor {
  param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][int]$Limit,
    [Parameter(Mandatory = $true)][string]$Name
  )
  New-Item -ItemType Directory -Path $Directory -Force | Out-Null
  $env:ROCKETSOLVER_TURN_BATCH_OUTPUT = $Directory
  $env:ROCKETSOLVER_POSTFLOP_SEED =
    'C:\Users\Administrator\Documents\kish\gto-work\btn-vs-bb-srp-100bb-seed.json'
  $env:ROCKETSOLVER_CDP = 'http://127.0.0.1:9229/json'
  $env:ROCKETSOLVER_THREADS = [string]$ThreadCount
  $env:ROCKETSOLVER_TARGET_ACCURACY = '0.003'
  $env:ROCKETSOLVER_BATCH_EXPLOITABILITY = '0.02'
  $env:ROCKETSOLVER_BATCH_LIMIT = [string]$Limit
  $env:ROCKETSOLVER_CDP_REQUEST_TIMEOUT_MS = '45000'
  $env:ROCKETSOLVER_SUPERVISOR_IDLE_TIMEOUT_MS = '360000'
  $env:ROCKETSOLVER_SUPERVISOR_MAX_RESTARTS = '8'

  Write-PipelineEvent -Event "$Name-starting" -Details @{
    directory = $Directory
    limit = $Limit
    threads = $ThreadCount
  }
  Invoke-LoggedNode `
    -Arguments @('scripts/gto/supervise-rocketsolver-turn-batch.mjs') `
    -Name $Name
  Write-PipelineEvent -Event "$Name-finished"
}

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class KishPostflopPipelineExecutionState
{
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
'@

$continuous = [Convert]::ToUInt32('80000000', 16)
$keepAwake = [Convert]::ToUInt32('80000001', 16)
New-Item -ItemType Directory -Path $pipelineDirectory -Force | Out-Null
Write-PipelineEvent -Event 'pipeline-started'

try {
  [void][KishPostflopPipelineExecutionState]::SetThreadExecutionState($keepAwake)

  while (-not (Test-FlopFinished)) {
    Start-Sleep -Seconds 30
  }
  Write-PipelineEvent -Event 'flop-checkpoint-complete'

  $flopRun = Get-GtoNodeProcess -Pattern 'run-rocketsolver-flop-batch\.mjs'
  if ($flopRun) {
    Wait-ForProcessToExit -ProcessId $flopRun.ProcessId
  }

  $binCount = (Get-ChildItem -LiteralPath $FlopDirectory -File -Filter '*.bin').Count
  $metadataCount = (Get-ChildItem -LiteralPath $FlopDirectory -File -Filter '*.json' |
    Where-Object { $_.BaseName -match '^[0-9a-z]{6}$' }).Count
  if ($binCount -ne 1755 -or $metadataCount -ne 1755) {
    throw "Flop dataset file count invalid: bin=$binCount metadata=$metadataCount"
  }
  Write-PipelineEvent -Event 'flop-files-validated' -Details @{
    binFiles = $binCount
    metadataFiles = $metadataCount
  }

  Invoke-LoggedNode `
    -Arguments @('scripts/gto/build-flop-aggregate-report.mjs') `
    -Name 'flop-aggregate'
  $aggregateManifest = Read-JsonFile -Path (
    Join-Path $RepositoryDirectory `
      'public\data\gto\gg-rnc-6max-100bb-drop-1p5bb-flop-aggregate-v1\manifest.json'
  )
  if (
    $null -eq $aggregateManifest -or
    $aggregateManifest.partial -or
    $aggregateManifest.completedFlops -ne 1755 -or
    $aggregateManifest.concreteFlopWeight -ne 22100
  ) {
    throw 'Full flop aggregate manifest validation failed'
  }
  Write-PipelineEvent -Event 'flop-aggregate-validated'

  $existingTurn = Get-GtoNodeProcess -Pattern (
    'supervise-rocketsolver-turn-batch\.mjs|' +
    'run-rocketsolver-turn-batch\.mjs'
  )
  if ($existingTurn) {
    Write-PipelineEvent -Event 'existing-turn-run-detected' -Details @{
      existingProcessId = $existingTurn.ProcessId
    }
    Wait-ForProcessToExit -ProcessId $existingTurn.ProcessId
  }

  if (-not (Test-TurnBatchFinished -Directory $TurnSmokeDirectory -ExpectedFlops 1)) {
    Start-TurnSupervisor -Directory $TurnSmokeDirectory -Limit 1 -Name 'turn-smoke'
  }
  if (-not (Test-TurnBatchFinished -Directory $TurnSmokeDirectory -ExpectedFlops 1)) {
    throw 'Turn smoke checkpoint validation failed'
  }

  $smokeCheckpoint = Read-JsonFile -Path (Join-Path $TurnSmokeDirectory 'checkpoint.json')
  $smokeResult = $smokeCheckpoint.completed[0]
  $smokeIndex = Read-JsonFile -Path (
    Join-Path $TurnSmokeDirectory "$($smokeResult.id)\index.json"
  )
  $turnTree = Read-JsonFile -Path (Join-Path $TurnSmokeDirectory 'turn-tree.json')
  if (
    $null -eq $smokeIndex -or
    $smokeIndex.concreteTurnWeight -ne 49 -or
    $smokeIndex.turnCount -lt 23 -or
    $smokeIndex.turnCount -gt 49 -or
    $null -eq $turnTree -or
    $turnTree.nodeCount -ne 72
  ) {
    throw 'Turn smoke structural validation failed'
  }
  $smokeBinCount = (
    Get-ChildItem -LiteralPath (Join-Path $TurnSmokeDirectory $smokeResult.id) `
      -File -Filter '*.bin'
  ).Count
  if ($smokeBinCount -ne $smokeIndex.turnCount) {
    throw "Turn smoke file count invalid: $smokeBinCount/$($smokeIndex.turnCount)"
  }
  Write-PipelineEvent -Event 'turn-smoke-validated' -Details @{
    solveElapsedMs = $smokeResult.solveElapsedMs
    exportElapsedMs = $smokeResult.exportElapsedMs
    turnCount = $smokeResult.turnCount
    byteLength = $smokeResult.byteLength
  }

  if (-not (Test-TurnBatchFinished -Directory $TurnDirectory -ExpectedFlops 1755)) {
    Start-TurnSupervisor -Directory $TurnDirectory -Limit 0 -Name 'turn-full'
  }
  if (-not (Test-TurnBatchFinished -Directory $TurnDirectory -ExpectedFlops 1755)) {
    throw 'Full turn checkpoint validation failed'
  }
  Write-PipelineEvent -Event 'turn-full-validated'

  $env:GTO_TURN_BATCH_INPUT = $TurnDirectory
  $env:GTO_TURN_REPORT_OUTPUT = 'F:\kish-gto\turn-aggregate-v1'
  Invoke-LoggedNode `
    -Arguments @('scripts/gto/build-turn-aggregate-report.mjs') `
    -Name 'turn-aggregate'
  $turnAggregateManifest = Read-JsonFile -Path (
    'F:\kish-gto\turn-aggregate-v1\manifest.json'
  )
  if (
    $null -eq $turnAggregateManifest -or
    $turnAggregateManifest.partial -or
    $turnAggregateManifest.completedFlops -ne 1755 -or
    $turnAggregateManifest.totalCanonicalTurnHistories -ne 63193 -or
    $turnAggregateManifest.nodeCount -ne 72
  ) {
    throw 'Full turn aggregate manifest validation failed'
  }
  Write-PipelineEvent -Event 'turn-aggregate-validated'
}
catch {
  Write-PipelineEvent -Event 'pipeline-failed' -Details @{
    error = $_.Exception.Message
    stack = $_.ScriptStackTrace
  }
  throw
}
finally {
  [void][KishPostflopPipelineExecutionState]::SetThreadExecutionState($continuous)
  Write-PipelineEvent -Event 'pipeline-stopped'
}

param(
  [string]$OutputDirectory = 'F:\kish-gto\flop-batch-v1',
  [string]$RepositoryDirectory = 'F:\Codex\kishpoker-site',
  [ValidateRange(1, 8)]
  [int]$ThreadCount = 8
)

$ErrorActionPreference = 'Stop'
$serviceLog = Join-Path $OutputDirectory 'service.log'
$checkpointPath = Join-Path $OutputDirectory 'checkpoint.json'

function Write-ServiceEvent {
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
  Add-Content -LiteralPath $serviceLog -Value ($record | ConvertTo-Json -Compress) -Encoding UTF8
}

function Test-BatchFinished {
  if (-not (Test-Path -LiteralPath $checkpointPath)) {
    return $false
  }

  try {
    $checkpoint = Get-Content -LiteralPath $checkpointPath -Raw | ConvertFrom-Json
    return (
      $checkpoint.completed.Count -ge $checkpoint.requestedFlops -and
      $checkpoint.failures.Count -eq 0
    )
  }
  catch {
    return $false
  }
}

function Get-ExistingRun {
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq 'node.exe' -and
      $_.CommandLine -match (
        'supervise-rocketsolver-flop-batch\.mjs|' +
        'run-rocketsolver-flop-batch\.mjs'
      )
    } |
    Select-Object -First 1
}

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class KishFlopBatchExecutionState
{
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
'@

$continuous = [Convert]::ToUInt32('80000000', 16)
$keepAwake = [Convert]::ToUInt32('80000001', 16)

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
Write-ServiceEvent -Event 'service-started'

try {
  [void][KishFlopBatchExecutionState]::SetThreadExecutionState($keepAwake)

  while (-not (Test-BatchFinished)) {
    $existing = Get-ExistingRun
    if ($existing) {
      Write-ServiceEvent -Event 'existing-run-detected' -Details @{
        existingProcessId = $existing.ProcessId
      }
      while (Get-Process -Id $existing.ProcessId -ErrorAction SilentlyContinue) {
        if (Test-BatchFinished) {
          break
        }
        Start-Sleep -Seconds 30
      }
      continue
    }

    $env:ROCKETSOLVER_FLOP_BATCH_OUTPUT = $OutputDirectory
    $env:ROCKETSOLVER_POSTFLOP_SEED =
      'C:\Users\Administrator\Documents\kish\gto-work\btn-vs-bb-srp-100bb-seed.json'
    $env:ROCKETSOLVER_CDP = 'http://127.0.0.1:9229/json'
    $env:ROCKETSOLVER_THREADS = [string]$ThreadCount
    $env:ROCKETSOLVER_TARGET_ACCURACY = '0.003'
    $env:ROCKETSOLVER_BATCH_EXPLOITABILITY = '0.02'
    $env:ROCKETSOLVER_BATCH_RETRIES = '2'
    $env:ROCKETSOLVER_CDP_REQUEST_TIMEOUT_MS = '45000'
    $env:ROCKETSOLVER_SUPERVISOR_IDLE_TIMEOUT_MS = '180000'
    $env:ROCKETSOLVER_SUPERVISOR_MAX_RESTARTS = '8'

    $supervisor = Start-Process `
      -FilePath 'C:\Program Files\nodejs\node.exe' `
      -ArgumentList 'scripts\gto\supervise-rocketsolver-flop-batch.mjs' `
      -WorkingDirectory $RepositoryDirectory `
      -WindowStyle Hidden `
      -PassThru

    Write-ServiceEvent -Event 'supervisor-started' -Details @{
      supervisorProcessId = $supervisor.Id
    }
    $supervisor.WaitForExit()
    Write-ServiceEvent -Event 'supervisor-exited' -Details @{
      supervisorProcessId = $supervisor.Id
      exitCode = $supervisor.ExitCode
    }

    if (-not (Test-BatchFinished)) {
      Start-Sleep -Seconds 30
    }
  }

  Write-ServiceEvent -Event 'batch-finished'
}
finally {
  [void][KishFlopBatchExecutionState]::SetThreadExecutionState($continuous)
  Write-ServiceEvent -Event 'service-stopped'
}

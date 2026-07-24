param(
  [Parameter(Mandatory = $true)]
  [int]$TargetProcessId
)

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class KishExecutionState
{
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
'@

$continuous = [Convert]::ToUInt32('80000000', 16)
$keepAwake = [Convert]::ToUInt32('80000001', 16)

try {
  [void][KishExecutionState]::SetThreadExecutionState($keepAwake)
  while (Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue) {
    Start-Sleep -Seconds 30
  }
}
finally {
  [void][KishExecutionState]::SetThreadExecutionState($continuous)
}

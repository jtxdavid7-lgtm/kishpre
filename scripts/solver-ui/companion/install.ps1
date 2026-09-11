$ErrorActionPreference = 'Stop'

$sourceRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$runtimeSource = Join-Path $sourceRoot 'runtime'
if (-not (Test-Path -LiteralPath (Join-Path $runtimeSource 'node.exe'))) {
    throw 'Installation package is incomplete: runtime\node.exe is missing.'
}

$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
if (-not $localAppData) { throw 'Windows LocalAppData directory is unavailable.' }
$installRoot = Join-Path $localAppData 'KishPoker\Solver Companion'
$installParent = Split-Path -Parent $installRoot
New-Item -ItemType Directory -Force -Path $installParent | Out-Null

if (Test-Path -LiteralPath $installRoot) {
    $resolvedInstall = (Resolve-Path -LiteralPath $installRoot).Path
    if (-not $resolvedInstall.StartsWith($installParent, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to replace unexpected installation path: $resolvedInstall"
    }
    Remove-Item -LiteralPath $resolvedInstall -Recurse -Force
}
Copy-Item -LiteralPath $runtimeSource -Destination $installRoot -Recurse -Force

$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$launcher = Join-Path $installRoot 'launch-hidden.vbs'
$quotedLaunch = '"{0}" "{1}"' -f $wscript, $launcher

$protocolRoot = 'HKCU:\Software\Classes\kishsolver'
New-Item -Path $protocolRoot -Force | Out-Null
Set-Item -Path $protocolRoot -Value 'URL:KishPoker Solver Protocol'
New-ItemProperty -Path $protocolRoot -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
$commandKey = New-Item -Path (Join-Path $protocolRoot 'shell\open\command') -Force
Set-Item -Path $commandKey.PSPath -Value ('"{0}" "{1}" "%1"' -f $wscript, $launcher)

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
New-Item -Path $runKey -Force | Out-Null
New-ItemProperty -Path $runKey -Name 'KishPokerSolverCompanion' -Value $quotedLaunch -PropertyType String -Force | Out-Null

$programs = Join-Path ([Environment]::GetFolderPath('Programs')) 'KishPoker'
New-Item -ItemType Directory -Force -Path $programs | Out-Null
$shortcutPath = Join-Path $programs 'KishPoker Solver.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $wscript
$shortcut.Arguments = '"{0}"' -f $launcher
$shortcut.WorkingDirectory = $installRoot
$shortcut.Description = 'Start KishPoker local Solver companion'
$shortcut.Save()

Start-Process -FilePath $wscript -ArgumentList ('"{0}"' -f $launcher)
Start-Sleep -Seconds 2
Start-Process 'https://kishpoker.cn/?tool=solver'

Write-Host ''
Write-Host 'KishPoker Solver Companion installed and started.' -ForegroundColor Green
Write-Host "Location: $installRoot"
Write-Host 'You may close this window.'

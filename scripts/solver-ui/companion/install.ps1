$ErrorActionPreference = 'Stop'

$script:unattendedInstall = (
    $env:KISH_SOLVER_INSTALL_UNATTENDED -eq '1' -or
    $env:KISH_SOLVER_INSTALL_NO_BROWSER -eq '1'
)
$script:installLogPath = $null
$script:installStage = 'Starting installation'
$script:installWarnings = New-Object System.Collections.Generic.List[string]

function Write-InstallLog {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    if (-not $script:installLogPath) { return }
    try {
        $timestamp = [DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')
        Add-Content -LiteralPath $script:installLogPath -Value "[$timestamp] $Message" -Encoding UTF8
    } catch {
        # Logging must never hide the original installation result.
    }
}

function Write-InstallStatus {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    $script:installStage = $Message
    Write-Host "[KishPoker Solver Setup] $Message" -ForegroundColor Cyan
    Write-InstallLog -Message $Message
}

function Invoke-OptionalInstallStep {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [scriptblock]$Action
    )

    Write-InstallStatus -Message $Name
    try {
        if ($env:KISH_SOLVER_INSTALL_TEST_DENY_OPTIONAL -eq '1') {
            throw [System.UnauthorizedAccessException]::new('Simulated optional integration policy denial.')
        }
        & $Action
        Write-InstallLog -Message "Optional integration succeeded: $Name"
        return $true
    } catch {
        $warning = "$Name was skipped because Windows denied it: $($_.Exception.Message)"
        $script:installWarnings.Add($warning)
        Write-InstallLog -Message "OPTIONAL WARNING: $warning"
        Write-Warning $warning
        return $false
    }
}

function Show-InstallMessage {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Title,
        [Parameter(Mandatory = $true)]
        [string]$Message,
        [ValidateSet('Information', 'Error')]
        [string]$Kind = 'Information'
    )

    if ($script:unattendedInstall) { return }
    try {
        $popupFlags = if ($Kind -eq 'Error') { 16 } else { 64 }
        $popup = New-Object -ComObject WScript.Shell
        [void]$popup.Popup($Message, 0, $Title, $popupFlags)
    } catch {
        Write-Warning "Unable to display the installer dialog: $($_.Exception.Message)"
    }
}

try {
    $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
    if (-not $localAppData) { throw 'Windows LocalAppData directory is unavailable.' }

    $solverDataRoot = Join-Path $localAppData 'KishPoker\Solver'
    New-Item -ItemType Directory -Force -Path $solverDataRoot | Out-Null
    $script:installLogPath = Join-Path $solverDataRoot 'install.log'
    Write-InstallLog -Message '--- Installation started ---'

    Write-InstallStatus -Message 'Checking the installation package...'
    $sourceRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
    $runtimeSource = Join-Path $sourceRoot 'runtime'
    Write-InstallLog -Message "Package source: $sourceRoot"
    if (-not (Test-Path -LiteralPath (Join-Path $runtimeSource 'node.exe'))) {
        throw 'Installation package is incomplete: runtime\node.exe is missing.'
    }

    $expectedVersion = (Get-Content -LiteralPath (Join-Path $runtimeSource 'VERSION') -Raw).Trim()
    if (-not $expectedVersion) { throw 'Installation package is incomplete: VERSION is empty.' }

    # Install each release beside the legacy directory instead of deleting it.
    # This keeps an old ACL, a locked file or security software from blocking a
    # working per-user installation. A retry gets a fresh suffix if necessary.
    $installPrefix = Join-Path $localAppData 'KishPoker\Solver Companion'
    $installRoot = "$installPrefix $expectedVersion"
    if (Test-Path -LiteralPath $installRoot) {
        $retrySuffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
        $installRoot = "$installRoot-$retrySuffix"
    }
    $installParent = Split-Path -Parent $installRoot
    New-Item -ItemType Directory -Force -Path $installParent | Out-Null

    function Test-LocalSolverPortOpen {
        $client = New-Object System.Net.Sockets.TcpClient
        try {
            $connectTask = $client.ConnectAsync('127.0.0.1', 8788)
            if (-not $connectTask.Wait(250)) { return $false }
            return $client.Connected
        } catch {
            return $false
        } finally {
            $client.Dispose()
        }
    }

    Write-InstallStatus -Message 'Stopping any previous local Solver...'
    $ownedProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $executablePath = $_.ExecutablePath
            if (-not $executablePath) { return $false }
            $fullExecutablePath = [IO.Path]::GetFullPath($executablePath)
            $isKnownRuntime = (
                [IO.Path]::GetFileName($fullExecutablePath).Equals('node.exe', [StringComparison]::OrdinalIgnoreCase) -or
                [IO.Path]::GetFileName($fullExecutablePath).Equals('gg_fulltree_direct_pack.exe', [StringComparison]::OrdinalIgnoreCase)
            )
            return $isKnownRuntime -and $fullExecutablePath.StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase)
        })
    if ($ownedProcesses.Count -gt 0) {
        $ownedProcesses | ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }

        $processDeadline = [DateTime]::UtcNow.AddSeconds(10)
        do {
            $remainingProcesses = @($ownedProcesses | Where-Object {
                Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
            })
            if ($remainingProcesses.Count -eq 0) { break }
            Start-Sleep -Milliseconds 200
        } while ([DateTime]::UtcNow -lt $processDeadline)
        if ($remainingProcesses.Count -gt 0) {
            throw 'The previous local Solver is still running. Close it and run this installer again.'
        }

        $portDeadline = [DateTime]::UtcNow.AddSeconds(10)
        while ((Test-LocalSolverPortOpen) -and [DateTime]::UtcNow -lt $portDeadline) {
            Start-Sleep -Milliseconds 250
        }
        if (Test-LocalSolverPortOpen) {
            throw 'Local port 8788 is still occupied. Close the previous Solver or other service and run this installer again.'
        }
    }

    if (Test-LocalSolverPortOpen) {
        throw 'Local port 8788 is already occupied by a process Windows did not allow the installer to stop. Close the previous Solver and run this installer again.'
    }

    Write-InstallStatus -Message 'Copying Solver files...'
    Copy-Item -LiteralPath $runtimeSource -Destination $installRoot -Recurse -Force
    foreach ($requiredInstalledFile in @('node.exe', 'launch-hidden.vbs', 'app\server.mjs', 'engine\gg_fulltree_direct_pack.exe', 'VERSION')) {
        if (-not (Test-Path -LiteralPath (Join-Path $installRoot $requiredInstalledFile) -PathType Leaf)) {
            throw "Installed runtime validation failed: $requiredInstalledFile is missing."
        }
    }

    $commandShell = $env:ComSpec
    $startScript = Join-Path $installRoot 'start.cmd'
    $startArguments = '/d /c ""{0}""' -f $startScript

    Write-InstallStatus -Message 'Starting the local Solver and checking that it is ready...'
    Start-Process -FilePath $commandShell -ArgumentList $startArguments -WindowStyle Hidden
    $expectedApiId = 'kishpoker-postflop-solver-api-v1'
    $expectedSchemaVersion = 1
    $healthUri = 'http://127.0.0.1:8788/api/v1/health'
    $healthDeadline = [DateTime]::UtcNow.AddSeconds(30)
    $health = $null
    do {
        Start-Sleep -Milliseconds 500
        try {
            $candidate = Invoke-RestMethod -Uri $healthUri -Method Get -TimeoutSec 2
            if (
                $candidate.status -eq 'ready' -and
                $candidate.companionVersion -eq $expectedVersion -and
                $candidate.apiId -eq $expectedApiId -and
                $candidate.schemaVersion -eq $expectedSchemaVersion
            ) {
                $health = $candidate
                break
            }
        } catch {
            # The local service may still be starting. Retry until the deadline.
        }
    } while ([DateTime]::UtcNow -lt $healthDeadline)

    if (-not $health) {
        $companionLogPath = Join-Path $solverDataRoot 'companion.log'
        throw "The local Solver did not start correctly. Expected version $expectedVersion. Log: $companionLogPath"
    }

    # These conveniences are not required for the service that is already
    # running. Corporate policies and antivirus products often deny one of
    # them; that must not turn a healthy local engine into a failed install.
    Invoke-OptionalInstallStep -Name 'Registering automatic start...' -Action {
        $startup = [Environment]::GetFolderPath('Startup')
        if (-not $startup) { throw 'Windows user Startup directory is unavailable.' }
        $startupShortcutPath = Join-Path $startup 'KishPoker Solver.lnk'
        $startupShell = New-Object -ComObject WScript.Shell
        $startupShortcut = $startupShell.CreateShortcut($startupShortcutPath)
        $startupShortcut.TargetPath = $commandShell
        $startupShortcut.Arguments = $startArguments
        $startupShortcut.WorkingDirectory = $installRoot
        $startupShortcut.WindowStyle = 7
        $startupShortcut.Description = 'Start KishPoker local Solver companion'
        $startupShortcut.Save()
    } | Out-Null

    Invoke-OptionalInstallStep -Name 'Creating the Start menu shortcut...' -Action {
        $programs = Join-Path ([Environment]::GetFolderPath('Programs')) 'KishPoker'
        New-Item -ItemType Directory -Force -Path $programs | Out-Null
        $shortcutPath = Join-Path $programs 'KishPoker Solver.lnk'
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $commandShell
        $shortcut.Arguments = $startArguments
        $shortcut.WorkingDirectory = $installRoot
        $shortcut.WindowStyle = 7
        $shortcut.Description = 'Start KishPoker local Solver companion'
        $shortcut.Save()
    } | Out-Null

    Write-InstallStatus -Message "Installation completed successfully. Version $expectedVersion is ready."
    Write-InstallLog -Message "Installed location: $installRoot"
    Write-InstallLog -Message '--- Installation succeeded ---'

    Write-Host ''
    Write-Host 'KishPoker Solver Companion installed and started.' -ForegroundColor Green
    Write-Host "Location: $installRoot"
    Write-Host "Install log: $script:installLogPath"
    Write-Host 'You may close this window.'

    $successMessage = @"
KishPoker Solver Companion was installed and started successfully.

Version: $expectedVersion
Location: $installRoot
"@
    if ($script:installWarnings.Count -gt 0) {
        $successMessage += "`r`n`r`nThe Solver is ready. Windows skipped $($script:installWarnings.Count) optional shortcut or auto-start setting(s); this does not affect the current session."
    }
    Show-InstallMessage -Title 'KishPoker Solver Setup' -Message $successMessage -Kind Information

    if (-not $script:unattendedInstall -and $env:KISH_SOLVER_INSTALL_NO_BROWSER -ne '1') {
        try {
            Write-InstallStatus -Message 'Opening KishPoker in your browser...'
            Start-Process 'https://www.kishpoker.cn/?tool=solver'
        } catch {
            Write-Warning 'The Solver is ready, but the website could not be opened automatically. Open https://www.kishpoker.cn/?tool=solver in your browser.'
            Write-InstallLog -Message "The website could not be opened automatically: $($_.Exception.Message)"
        }
    }
} catch {
    $failureMessage = $_.Exception.Message
    $failureType = $_.Exception.GetType().FullName
    $failureStack = $_.ScriptStackTrace
    Write-InstallLog -Message "INSTALLATION FAILED: $failureMessage"
    Write-InstallLog -Message "Stage: $script:installStage"
    Write-InstallLog -Message "Exception type: $failureType"
    Write-InstallLog -Message ("HResult: 0x{0:X8}" -f ($_.Exception.HResult -band 0xffffffffL))
    Write-InstallLog -Message "FullyQualifiedErrorId: $($_.FullyQualifiedErrorId)"
    Write-InstallLog -Message "Category: $($_.CategoryInfo)"
    if ($_.TargetObject) { Write-InstallLog -Message "Target: $($_.TargetObject)" }
    if ($failureStack) { Write-InstallLog -Message "Script stack: $failureStack" }
    Write-InstallLog -Message '--- Installation failed ---'

    Write-Host ''
    Write-Host 'KishPoker Solver installation failed.' -ForegroundColor Red
    Write-Host $failureMessage -ForegroundColor Red
    if ($script:installLogPath) {
        Write-Host "Details were saved to: $script:installLogPath"
    }

    $dialogMessage = "Installation failed during:`r`n$script:installStage`r`n`r`n$failureMessage"
    if ($script:installLogPath) {
        $dialogMessage += "`r`n`r`nDetails were saved to:`r`n$script:installLogPath"
    }
    Show-InstallMessage -Title 'KishPoker Solver Setup - Installation failed' -Message $dialogMessage -Kind Error
    exit 1
}

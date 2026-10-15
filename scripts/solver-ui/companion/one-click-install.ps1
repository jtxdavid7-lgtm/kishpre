param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$PayloadPath,
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$DestinationPath
)

$ErrorActionPreference = 'Stop'
$unattendedInstall = (
    $env:KISH_SOLVER_INSTALL_UNATTENDED -eq '1' -or
    $env:KISH_SOLVER_INSTALL_NO_BROWSER -eq '1'
)
$script:installLogPath = $null

function Save-BootstrapFailure {
    param(
        [Parameter(Mandatory = $true)]
        [System.Management.Automation.ErrorRecord]$ErrorRecord
    )

    $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
    if ($localAppData) {
        try {
            $logRoot = Join-Path $localAppData 'KishPoker\Solver'
            New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
            $script:installLogPath = Join-Path $logRoot 'install.log'
            $timestamp = [DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')
            Add-Content -LiteralPath $script:installLogPath -Encoding UTF8 -Value @(
                "[$timestamp] --- Installation started ---",
                "[$timestamp] INSTALLATION FAILED while preparing the package: $($ErrorRecord.Exception.Message)",
                "[$timestamp] Exception type: $($ErrorRecord.Exception.GetType().FullName)",
                "[$timestamp] Script stack: $($ErrorRecord.ScriptStackTrace)",
                "[$timestamp] --- Installation failed ---"
            )
        } catch {
            # Keep reporting the original extraction error even if logging fails.
        }
    }
}

function Show-BootstrapFailure {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    if ($unattendedInstall) { return }
    try {
        $popup = New-Object -ComObject WScript.Shell
        [void]$popup.Popup($Message, 0, 'KishPoker Solver Setup - Installation failed', 16)
    } catch {
        Write-Warning "Unable to display the installer dialog: $($_.Exception.Message)"
    }
}

try {
    Write-Host '[KishPoker Solver Setup] Preparing the installation package...' -ForegroundColor Cyan
    Expand-Archive -LiteralPath $PayloadPath -DestinationPath $DestinationPath -Force

    $installerScript = Join-Path $DestinationPath 'install.ps1'
    if (-not (Test-Path -LiteralPath $installerScript -PathType Leaf)) {
        throw 'Installation package is incomplete: install.ps1 is missing.'
    }

    Write-Host '[KishPoker Solver Setup] Package ready. Starting installation...' -ForegroundColor Cyan
    & $installerScript
} catch {
    Save-BootstrapFailure -ErrorRecord $_
    $failureMessage = "Installation failed while preparing the package.`r`n`r`n$($_.Exception.Message)"
    if ($script:installLogPath) {
        $failureMessage += "`r`n`r`nDetails were saved to:`r`n$script:installLogPath"
    }

    Write-Host ''
    Write-Host 'KishPoker Solver installation failed.' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    if ($script:installLogPath) { Write-Host "Details were saved to: $script:installLogPath" }
    Show-BootstrapFailure -Message $failureMessage
    exit 1
}

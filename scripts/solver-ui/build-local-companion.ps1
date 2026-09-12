param(
    [string]$Version = '0.1.5',
    [string]$SolverBinary = 'F:\kish-gto\solver-engines\postflop-solver-gg\target\release\examples\gg_fulltree_direct_pack.exe'
)

$ErrorActionPreference = 'Stop'
$siteRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$solverSourceRoot = (Resolve-Path -LiteralPath (Join-Path (Split-Path -Parent $SolverBinary) '..\..\..')).Path
$outputRoot = Join-Path $siteRoot 'output\solver-companion'
$stageRoot = Join-Path $outputRoot "kishpoker-solver-companion-win-x64-$Version"
$runtimeRoot = Join-Path $stageRoot 'runtime'
$downloadRoot = Join-Path $siteRoot 'public\downloads'
$zipPath = Join-Path $downloadRoot "kishpoker-solver-companion-win-x64-$Version.zip"
$installerPath = Join-Path $downloadRoot "kishpoker-solver-companion-win-x64-$Version-setup.exe"

foreach ($required in @($SolverBinary, (Get-Command node.exe).Source)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required runtime file is missing: $required"
    }
}

$resolvedOutput = [IO.Path]::GetFullPath($outputRoot)
$expectedPrefix = [IO.Path]::GetFullPath((Join-Path $siteRoot 'output')) + [IO.Path]::DirectorySeparatorChar
if (-not $resolvedOutput.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe staging path: $resolvedOutput"
}
if (Test-Path -LiteralPath $outputRoot) {
    Remove-Item -LiteralPath $outputRoot -Recurse -Force
}

New-Item -ItemType Directory -Force -Path (Join-Path $runtimeRoot 'app'), (Join-Path $runtimeRoot 'engine'), $downloadRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'companion\install.cmd') -Destination $stageRoot
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'companion\install.ps1') -Destination $stageRoot
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'companion\README.txt') -Destination $stageRoot
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'companion\THIRD_PARTY_NOTICES.txt') -Destination $stageRoot
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'companion\start.cmd') -Destination $runtimeRoot
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'companion\launch-hidden.vbs') -Destination $runtimeRoot
Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination (Join-Path $runtimeRoot 'node.exe')
Copy-Item -LiteralPath $SolverBinary -Destination (Join-Path $runtimeRoot 'engine\gg_fulltree_direct_pack.exe')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'server.mjs') -Destination (Join-Path $runtimeRoot 'app')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'protocol.mjs') -Destination (Join-Path $runtimeRoot 'app')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'compact-pack.mjs') -Destination (Join-Path $runtimeRoot 'app')
Set-Content -LiteralPath (Join-Path $runtimeRoot 'VERSION') -Value $Version -Encoding ASCII

$stagedLauncher = Join-Path $runtimeRoot 'launch-hidden.vbs'
$cscript = Join-Path $env:WINDIR 'System32\cscript.exe'
& $cscript '//nologo' $stagedLauncher '--validate-only'
if ($LASTEXITCODE -ne 0) {
    throw "launch-hidden.vbs validation failed (exit $LASTEXITCODE)."
}

$sourceDestination = Join-Path $stageRoot 'source\postflop-solver'
New-Item -ItemType Directory -Force -Path $sourceDestination | Out-Null
Get-ChildItem -LiteralPath $solverSourceRoot -Force |
    Where-Object { $_.Name -notin @('.git', 'target') } |
    Copy-Item -Destination $sourceDestination -Recurse -Force

if (Test-Path -LiteralPath $zipPath) {
    $resolvedZip = (Resolve-Path -LiteralPath $zipPath).Path
    $resolvedDownloads = (Resolve-Path -LiteralPath $downloadRoot).Path + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedZip.StartsWith($resolvedDownloads, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe archive path: $resolvedZip"
    }
    Remove-Item -LiteralPath $resolvedZip -Force
}
Compress-Archive -LiteralPath $stageRoot -DestinationPath $zipPath -CompressionLevel Optimal

$iexpress = (Get-Command iexpress.exe -ErrorAction Stop).Source
$installerBuildRoot = Join-Path ([IO.Path]::GetTempPath()) "kishpoker-solver-installer-$Version"
$installerPayloadRoot = Join-Path $installerBuildRoot 'payload'
$installerPayloadZip = Join-Path $installerPayloadRoot 'payload.zip'
$installerBootstrap = Join-Path $installerPayloadRoot 'setup.cmd'
$installerSed = Join-Path $installerBuildRoot 'installer.sed'
$installerOutput = Join-Path $installerBuildRoot "kishpoker-solver-companion-win-x64-$Version-setup.exe"

if (Test-Path -LiteralPath $installerBuildRoot) {
    $resolvedInstallerBuild = (Resolve-Path -LiteralPath $installerBuildRoot).Path
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedInstallerBuild.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe installer staging path: $resolvedInstallerBuild"
    }
    Remove-Item -LiteralPath $installerBuildRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $installerPayloadRoot | Out-Null
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stageRoot,
    $installerPayloadZip,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
)
$payloadArchive = [System.IO.Compression.ZipFile]::OpenRead($installerPayloadZip)
try {
    $payloadEntries = @($payloadArchive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    foreach ($requiredEntry in @(
        'install.ps1',
        'runtime/node.exe',
        'runtime/launch-hidden.vbs',
        'runtime/start.cmd',
        'runtime/app/server.mjs',
        'runtime/engine/gg_fulltree_direct_pack.exe'
    )) {
        if ($payloadEntries -notcontains $requiredEntry) {
            throw "Installer payload is missing required entry: $requiredEntry"
        }
    }
} finally {
    $payloadArchive.Dispose()
}
$payloadHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installerPayloadZip).Hash
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'companion\one-click-install.cmd') -Destination $installerBootstrap

$installerOutputForSed = $installerOutput
$installerPayloadForSed = $installerPayloadRoot.TrimEnd('\') + '\'
$sedContent = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$installerOutputForSed
FriendlyName=KishPoker Solver Setup
AppLaunched=cmd.exe /d /c setup.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles
[Strings]
FILE0="payload.zip"
FILE1="setup.cmd"
[SourceFiles]
SourceFiles0=$installerPayloadForSed
[SourceFiles0]
%FILE0%=
%FILE1%=
"@
Set-Content -LiteralPath $installerSed -Value $sedContent -Encoding ASCII
$iexpressProcess = Start-Process -FilePath $iexpress -ArgumentList @('/N', '/Q', $installerSed) -Wait -PassThru -WindowStyle Hidden
if ($iexpressProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $installerOutput -PathType Leaf)) {
    throw "IExpress failed to build the one-click installer (exit $($iexpressProcess.ExitCode))."
}
$installerVerificationRoot = Join-Path $installerBuildRoot 'verify'
New-Item -ItemType Directory -Path $installerVerificationRoot | Out-Null
$tar = (Get-Command tar.exe -ErrorAction Stop).Source
& $tar '-xf' $installerOutput '-C' $installerVerificationRoot 'payload.zip'
if ($LASTEXITCODE -ne 0) {
    throw "Unable to extract the installer payload for verification (exit $LASTEXITCODE)."
}
$embeddedPayloadZip = Join-Path $installerVerificationRoot 'payload.zip'
if (-not (Test-Path -LiteralPath $embeddedPayloadZip -PathType Leaf)) {
    throw 'The generated installer does not contain payload.zip.'
}
$embeddedPayloadHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $embeddedPayloadZip).Hash
if ($embeddedPayloadHash -ne $payloadHash) {
    throw 'The generated installer payload does not match the validated source payload.'
}
Copy-Item -LiteralPath $installerOutput -Destination $installerPath -Force
Remove-Item -LiteralPath $installerBuildRoot -Recurse -Force

$zip = Get-Item -LiteralPath $zipPath
$installer = Get-Item -LiteralPath $installerPath
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
$installerHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installerPath).Hash.ToLowerInvariant()
[pscustomobject]@{
    version = $Version
    zipPath = $zip.FullName
    zipBytes = $zip.Length
    zipMiB = [Math]::Round($zip.Length / 1MB, 2)
    installerPath = $installer.FullName
    installerBytes = $installer.Length
    installerMiB = [Math]::Round($installer.Length / 1MB, 2)
    installerSha256 = $installerHash
    solverBytes = (Get-Item -LiteralPath $SolverBinary).Length
    nodeBytes = (Get-Item -LiteralPath (Get-Command node.exe).Source).Length
    sha256 = $hash
} | ConvertTo-Json

param(
    [string]$Version = '0.1.1',
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

$zip = Get-Item -LiteralPath $zipPath
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
[pscustomobject]@{
    version = $Version
    zipPath = $zip.FullName
    zipBytes = $zip.Length
    zipMiB = [Math]::Round($zip.Length / 1MB, 2)
    solverBytes = (Get-Item -LiteralPath $SolverBinary).Length
    nodeBytes = (Get-Item -LiteralPath (Get-Command node.exe).Source).Length
    sha256 = $hash
} | ConvertTo-Json

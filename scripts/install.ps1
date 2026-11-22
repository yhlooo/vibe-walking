#Requires -Version 5.1

$ErrorActionPreference = 'Stop'

$version = ''
$run = $false
foreach ($argument in $args) {
    if ($argument -ceq '--run') {
        $run = $true
    } elseif ($argument -like '-*') {
        throw "Unknown option $argument"
    } elseif ($version) {
        throw 'Usage: .\install.ps1 [version] [--run]'
    } else {
        $version = $argument
    }
}
if (-not $version) {
    $version = 'latest'
}

$processor = $env:PROCESSOR_ARCHITEW6432
if (-not $processor) {
    $processor = $env:PROCESSOR_ARCHITECTURE
}
$arch = switch ($processor) {
    AMD64 { 'amd64' }
    ARM64 { 'arm64' }
    default { throw "Unsupported Windows architecture: $processor" }
}

$installDir = $env:INSTALL_DIR
if (-not $installDir) {
    $installDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\vibe-walking'
}
$installDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($installDir)
$binary = Join-Path $installDir 'vibe-walking.exe'

$releaseBase = 'https://github.com/yhlooo/vibe-walking/releases'
$archive = "vibe-walking-windows-$arch.zip"
if ($version -ceq 'latest') {
    $url = "$releaseBase/latest/download/$archive"
} else {
    $tag = [Uri]::EscapeDataString($version)
    $url = "$releaseBase/download/$tag/$archive"
}

Write-Host "Installing vibe-walking ($version, windows/$arch) to '$binary' ..."
Write-Host "Downloading from $url"

$tempDir = Join-Path ([IO.Path]::GetTempPath()) ("vibe-walking-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tempDir | Out-Null
try {
    $archivePath = Join-Path $tempDir $archive
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archivePath
    Expand-Archive -LiteralPath $archivePath -DestinationPath $tempDir
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $tempDir 'vibe-walking.exe') -Destination $binary -Force
} finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $installDir) {
    $userPath = (@($userPath, $installDir) | Where-Object { $_ }) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $userPath, 'User')
}
if (($env:Path -split ';') -notcontains $installDir) {
    $env:Path = "$env:Path;$installDir"
}

if ($run) {
    & $binary
    exit $LASTEXITCODE
}

#Requires -Version 5.1

$ErrorActionPreference = 'Stop'

# 解析可选版本和安装后启动开关。
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

# 优先用系统架构选择发布包，兼容 32 位 PowerShell。
$processor = $env:PROCESSOR_ARCHITEW6432
if (-not $processor) {
    $processor = $env:PROCESSOR_ARCHITECTURE
}
$arch = switch ($processor) {
    AMD64 { 'amd64' }
    ARM64 { 'arm64' }
    default { throw "Unsupported Windows architecture: $processor" }
}

# 解析自定义安装目录，缺省时使用当前用户的应用目录。
$installDir = $env:INSTALL_DIR
if (-not $installDir) {
    $installDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\vibe-walking'
}
$installDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($installDir)
$binary = Join-Path $installDir 'vibe-walking.exe'

# 根据版本和系统架构选择发布压缩包。
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

# 在临时目录下载、解压并安装，结束时清理临时文件。
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

# 让当前进程和以后打开的用户终端都能找到可执行文件。
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $installDir) {
    $userPath = (@($userPath, $installDir) | Where-Object { $_ }) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $userPath, 'User')
}
if (($env:Path -split ';') -notcontains $installDir) {
    $env:Path = "$env:Path;$installDir"
}

# 按需启动应用，并将其退出码返回给调用方。
if ($run) {
    & $binary
    exit $LASTEXITCODE
}

#Requires -Version 5.1
<#
.SYNOPSIS
    ccbox installer for Windows

.DESCRIPTION
    Downloads and installs ccbox binary and wrapper for Windows.
    Installs to WindowsApps directory which is already in PATH by default.

.EXAMPLE
    irm https://raw.githubusercontent.com/sungurerdim/ccbox/main/install.ps1 | iex

.NOTES
    Environment variables:
      CCBOX_INSTALL_DIR  - Installation directory (default: %LOCALAPPDATA%\Microsoft\WindowsApps)
      CCBOX_VERSION      - Specific version to install (default: latest)
#>

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Configuration
$Repo = "sungurerdim/ccbox"
$DefaultInstallDir = "$env:LOCALAPPDATA\Microsoft\WindowsApps"
$InstallDir = if ($env:CCBOX_INSTALL_DIR) { $env:CCBOX_INSTALL_DIR } else { $DefaultInstallDir }
$Version = $env:CCBOX_VERSION

# Output helpers
function Write-Step {
    param($Label, $Value)
    Write-Host "  $Label" -ForegroundColor DarkGray -NoNewline
    Write-Host "  $Value"
}

function Write-Task {
    param($Message)
    Write-Host "  $Message" -NoNewline -ForegroundColor White
}

function Write-Done {
    Write-Host " done" -ForegroundColor Green
}

function Write-Fail {
    param($Message)
    Write-Host " failed" -ForegroundColor Red
    Write-Host ""
    Write-Host "  $Message" -ForegroundColor Red
}

function Get-LatestVersion {
    $response = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
    return $response.tag_name
}

function Install-Ccbox {
    param(
        [string]$Platform,
        [string]$Ver
    )

    $binaryName = "ccbox-bin-$Ver-$Platform.exe"
    $binaryUrl = "https://github.com/$Repo/releases/download/$Ver/$binaryName"
    $wrapperCmdUrl = "https://raw.githubusercontent.com/$Repo/$Ver/scripts/wrapper/ccbox.cmd"
    $wrapperPs1Url = "https://raw.githubusercontent.com/$Repo/$Ver/scripts/wrapper/ccbox.ps1"

    if (!(Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }

    $targetBinary = Join-Path $InstallDir "ccbox-bin.exe"
    $targetCmd = Join-Path $InstallDir "ccbox.cmd"
    $targetPs1 = Join-Path $InstallDir "ccbox.ps1"

    try {
        Write-Task "Downloading ccbox-bin.exe ..."
        Invoke-WebRequest -Uri $binaryUrl -OutFile $targetBinary -UseBasicParsing
        Write-Done

        Write-Task "Downloading ccbox.cmd ..."
        Invoke-WebRequest -Uri $wrapperCmdUrl -OutFile $targetCmd -UseBasicParsing
        Write-Done

        Write-Task "Downloading ccbox.ps1 ..."
        Invoke-WebRequest -Uri $wrapperPs1Url -OutFile $targetPs1 -UseBasicParsing
        Write-Done
    }
    catch {
        Write-Fail $_.Exception.Message
        throw
    }

    Write-Host ""
    Write-Host "  Installed to " -NoNewline -ForegroundColor DarkGray
    Write-Host $InstallDir
    Write-Host "    ccbox.cmd     " -NoNewline -ForegroundColor Cyan
    Write-Host "launcher" -ForegroundColor DarkGray
    Write-Host "    ccbox.ps1     " -NoNewline -ForegroundColor Cyan
    Write-Host "wrapper" -ForegroundColor DarkGray
    Write-Host "    ccbox-bin.exe " -NoNewline -ForegroundColor Cyan
    Write-Host "binary" -ForegroundColor DarkGray
}

function Test-InPath {
    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    $systemPath = [Environment]::GetEnvironmentVariable("PATH", "Machine")
    $fullPath = "$userPath;$systemPath"

    if ($fullPath -like "*$InstallDir*") {
        return
    }

    Write-Host ""
    Write-Host "  PATH " -NoNewline -ForegroundColor Yellow
    Write-Host "$InstallDir is not in your PATH" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Run as Administrator:" -ForegroundColor DarkGray
    Write-Host "  [Environment]::SetEnvironmentVariable('PATH', `"$InstallDir;`" + [Environment]::GetEnvironmentVariable('PATH', 'User'), 'User')"
}

function Test-Docker {
    try {
        $null = Get-Command docker -ErrorAction Stop
    }
    catch {
        Write-Host ""
        Write-Host "  Docker " -NoNewline -ForegroundColor Yellow
        Write-Host "not found - install from https://docs.docker.com/get-docker/" -ForegroundColor Yellow
    }
}

function Main {
    # Banner
    Write-Host ""
    Write-Host "  ccbox" -ForegroundColor White -NoNewline
    Write-Host " installer" -ForegroundColor DarkGray
    Write-Host ""

    # Detect platform
    $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
    $platform = "windows-$arch"

    # Get version
    if (!$Version) {
        $Version = Get-LatestVersion
    }

    # Info
    Write-Step "Platform" $platform
    Write-Step "Version " $Version
    Write-Host ""

    # Install
    Install-Ccbox -Platform $platform -Ver $Version

    # Check PATH
    Test-InPath

    # Check Docker
    Test-Docker

    # Footer
    Write-Host ""
    Write-Host "  Done! " -NoNewline -ForegroundColor Green
    Write-Host "Run " -NoNewline -ForegroundColor DarkGray
    Write-Host "ccbox --help" -NoNewline -ForegroundColor White
    Write-Host " to get started." -ForegroundColor DarkGray
    Write-Host ""
}

Main

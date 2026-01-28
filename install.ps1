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

# Configuration
$Repo = "sungurerdim/ccbox"
# WindowsApps is in PATH by default on Windows 10/11
$DefaultInstallDir = "$env:LOCALAPPDATA\Microsoft\WindowsApps"
$InstallDir = if ($env:CCBOX_INSTALL_DIR) { $env:CCBOX_INSTALL_DIR } else { $DefaultInstallDir }
$Version = $env:CCBOX_VERSION

function Write-Info { param($Message) Write-Host $Message -ForegroundColor Blue }
function Write-Success { param($Message) Write-Host $Message -ForegroundColor Green }
function Write-Warn { param($Message) Write-Host $Message -ForegroundColor Yellow }
function Write-Err { param($Message) Write-Host $Message -ForegroundColor Red }

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

    Write-Info "Downloading ccbox $Ver for $Platform..."

    # Create install directory if it doesn't exist
    if (!(Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }

    $targetBinary = Join-Path $InstallDir "ccbox-bin.exe"
    $targetCmd = Join-Path $InstallDir "ccbox.cmd"
    $targetPs1 = Join-Path $InstallDir "ccbox.ps1"

    try {
        # Download binary
        Write-Info "  Downloading ccbox-bin.exe..."
        Invoke-WebRequest -Uri $binaryUrl -OutFile $targetBinary -UseBasicParsing

        # Download wrapper .cmd
        Write-Info "  Downloading ccbox.cmd..."
        Invoke-WebRequest -Uri $wrapperCmdUrl -OutFile $targetCmd -UseBasicParsing

        # Download wrapper .ps1
        Write-Info "  Downloading ccbox.ps1..."
        Invoke-WebRequest -Uri $wrapperPs1Url -OutFile $targetPs1 -UseBasicParsing
    }
    catch {
        Write-Err "Failed to download ccbox"
        Write-Err "Binary URL: $binaryUrl"
        throw
    }

    Write-Success "Installed ccbox to $InstallDir"
    Write-Host "  - ccbox.cmd (launcher)"
    Write-Host "  - ccbox.ps1 (wrapper)"
    Write-Host "  - ccbox-bin.exe (binary)"
}

function Test-InPath {
    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    $systemPath = [Environment]::GetEnvironmentVariable("PATH", "Machine")
    $fullPath = "$userPath;$systemPath"

    # Check if install directory is in PATH
    if ($fullPath -like "*$InstallDir*") {
        return
    }

    Write-Warn ""
    Write-Warn "WARNING: $InstallDir is not in your PATH"
    Write-Warn ""
    Write-Warn "Add it to your PATH by running this command in PowerShell (as Administrator):"
    Write-Host ""
    Write-Host "  [Environment]::SetEnvironmentVariable('PATH', `"$InstallDir;`" + [Environment]::GetEnvironmentVariable('PATH', 'User'), 'User')"
    Write-Host ""
    Write-Warn "Or add it manually via: Settings > System > About > Advanced system settings > Environment Variables"
    Write-Host ""
}

function Test-Docker {
    try {
        $null = Get-Command docker -ErrorAction Stop
    }
    catch {
        Write-Warn ""
        Write-Warn "Docker is required but not found."
        Write-Warn "Install Docker: https://docs.docker.com/get-docker/"
    }
}

function Main {
    Write-Host ""
    Write-Info "ccbox Installer"
    Write-Host ""

    # Detect platform
    $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
    $platform = "windows-$arch"
    Write-Info "Detected platform: $platform"

    # Get version
    if (!$Version) {
        Write-Info "Fetching latest version..."
        $Version = Get-LatestVersion
    }
    Write-Info "Version: $Version"
    Write-Host ""

    # Install
    Install-Ccbox -Platform $platform -Ver $Version

    # Check PATH and warn if needed
    Test-InPath

    # Check Docker
    Test-Docker

    Write-Host ""
    Write-Success "Installation complete!"
    Write-Host ""
    Write-Host "Get started:"
    Write-Host "  ccbox --help"
    Write-Host ""
}

Main

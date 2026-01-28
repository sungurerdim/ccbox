#Requires -Version 5.1
<#
.SYNOPSIS
    ccbox wrapper script for Windows

.DESCRIPTION
    This wrapper handles:
      - update: Download and install new binary
      - uninstall: Remove ccbox completely
      - version: Show wrapper and binary versions
      - *: Pass-through to ccbox-bin.exe
#>

$ErrorActionPreference = "Stop"

# Configuration
$Repo = "sungurerdim/ccbox"
$GitHubApi = "https://api.github.com/repos/$Repo/releases/latest"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$CcboxBin = Join-Path $ScriptDir "ccbox-bin.exe"

# Color functions
function Write-Info { param($Message) Write-Host $Message -ForegroundColor Blue }
function Write-Success { param($Message) Write-Host $Message -ForegroundColor Green }
function Write-Warn { param($Message) Write-Host $Message -ForegroundColor Yellow }
function Write-Err { param($Message) Write-Host $Message -ForegroundColor Red }
function Write-Dim { param($Message) Write-Host $Message -ForegroundColor DarkGray }

# Get current binary version
function Get-CurrentVersion {
    if (Test-Path $CcboxBin) {
        try {
            $output = & $CcboxBin --version 2>$null
            if ($output -match "ccbox (.+)") {
                return "v$($Matches[1])"
            }
            return $output
        } catch {
            return "unknown"
        }
    }
    return "not installed"
}

# Fetch latest version from GitHub
function Get-LatestVersion {
    try {
        $response = Invoke-RestMethod -Uri $GitHubApi -Headers @{ "User-Agent" = "ccbox" }
        return $response.tag_name
    } catch {
        return $null
    }
}

# Compare semantic versions
# Returns: 0 if equal, 1 if a > b, -1 if a < b
function Compare-SemVer {
    param([string]$a, [string]$b)

    $a = $a -replace "^v", ""
    $b = $b -replace "^v", ""

    if ($a -eq $b) { return 0 }

    $partsA = $a.Split('.') | ForEach-Object { [int]$_ }
    $partsB = $b.Split('.') | ForEach-Object { [int]$_ }

    $max = [Math]::Max($partsA.Count, $partsB.Count)

    for ($i = 0; $i -lt $max; $i++) {
        $numA = if ($i -lt $partsA.Count) { $partsA[$i] } else { 0 }
        $numB = if ($i -lt $partsB.Count) { $partsB[$i] } else { 0 }

        if ($numA -gt $numB) { return 1 }
        if ($numA -lt $numB) { return -1 }
    }

    return 0
}

# Update command
function Invoke-Update {
    param([switch]$Force)

    $current = Get-CurrentVersion

    Write-Dim "Checking for updates..."
    $latest = Get-LatestVersion

    if (-not $latest) {
        Write-Err "Failed to fetch latest version (network error or rate limited)"
        exit 1
    }

    Write-Host ""
    Write-Info "Current version: $current"
    Write-Info "Latest version:  $latest"
    Write-Host ""

    $cmp = Compare-SemVer $current $latest

    if ($cmp -ge 0) {
        Write-Success "ccbox is already up to date"
        return
    }

    # Confirm upgrade
    if (-not $Force) {
        $answer = Read-Host "Update to $latest? [Y/n]"
        if ($answer -match "^[nN]") {
            Write-Dim "Cancelled."
            return
        }
    }

    # Detect platform
    $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
    $platform = "windows-$arch"
    $binaryName = "ccbox-bin-$latest-$platform.exe"
    $downloadUrl = "https://github.com/$Repo/releases/download/$latest/$binaryName"

    Write-Info "Downloading ccbox-bin $latest for $platform..."

    # Download to temp file
    $tmpFile = [System.IO.Path]::GetTempFileName()
    $bakFile = "$CcboxBin.bak"

    try {
        Invoke-WebRequest -Uri $downloadUrl -OutFile $tmpFile -UseBasicParsing

        # Backup and replace
        if (Test-Path $CcboxBin) {
            Move-Item -Path $CcboxBin -Destination $bakFile -Force
        }

        Move-Item -Path $tmpFile -Destination $CcboxBin -Force

        # Remove backup
        if (Test-Path $bakFile) {
            Remove-Item -Path $bakFile -Force
        }

        Write-Host ""
        Write-Success "Updated to $latest"
    } catch {
        Write-Err "Failed to download binary"
        Write-Err "URL: $downloadUrl"

        # Restore backup if exists
        if (Test-Path $bakFile) {
            Move-Item -Path $bakFile -Destination $CcboxBin -Force
        }

        throw
    } finally {
        if (Test-Path $tmpFile) {
            Remove-Item -Path $tmpFile -Force -ErrorAction SilentlyContinue
        }
    }
}

# Uninstall command
function Invoke-Uninstall {
    param([switch]$Force)

    $wrapperCmd = Join-Path $ScriptDir "ccbox.cmd"
    $wrapperPs1 = Join-Path $ScriptDir "ccbox.ps1"

    Write-Warn "This will remove ccbox completely:"
    Write-Host "  - $CcboxBin"
    Write-Host "  - $wrapperCmd"
    Write-Host "  - $wrapperPs1"
    Write-Host ""

    if (-not $Force) {
        $answer = Read-Host "Continue? [y/N]"
        if ($answer -notmatch "^[yY]") {
            Write-Dim "Cancelled."
            return
        }
    }

    # Remove binary
    if (Test-Path $CcboxBin) {
        Remove-Item -Path $CcboxBin -Force
        Write-Dim "Removed: $CcboxBin"
    }

    # Remove wrapper cmd
    if (Test-Path $wrapperCmd) {
        Remove-Item -Path $wrapperCmd -Force
        Write-Dim "Removed: $wrapperCmd"
    }

    # Remove this script (self-delete)
    if (Test-Path $wrapperPs1) {
        Remove-Item -Path $wrapperPs1 -Force
        Write-Dim "Removed: $wrapperPs1"
    }

    Write-Host ""
    Write-Success "ccbox has been uninstalled"
}

# Version command
function Show-Version {
    param([switch]$Check)

    $current = Get-CurrentVersion

    Write-Host "ccbox wrapper v1.0.0"
    Write-Host "ccbox-bin    $current"

    if ($Check) {
        Write-Host ""
        Write-Dim "Checking for updates..."

        $latest = Get-LatestVersion

        if (-not $latest) {
            Write-Warn "Could not check for updates (network error or rate limited)"
            return
        }

        $cmp = Compare-SemVer $current $latest

        if ($cmp -ge 0) {
            Write-Success "ccbox is up to date"
        } else {
            Write-Warn "Update available: $current -> $latest"
            Write-Host ""
            Write-Dim "Run 'ccbox update' to update"
        }
    }
}

# Pass-through to ccbox-bin
function Invoke-PassThrough {
    param([string[]]$Arguments)

    if (-not (Test-Path $CcboxBin)) {
        Write-Err "ccbox-bin.exe not found at: $CcboxBin"
        Write-Host ""
        Write-Dim "Run 'ccbox update' to install"
        exit 1
    }

    & $CcboxBin @Arguments
    exit $LASTEXITCODE
}

# Main
function Main {
    $allArgs = $args

    # No arguments - pass through
    if ($allArgs.Count -eq 0) {
        Invoke-PassThrough -Arguments @()
        return
    }

    $command = $allArgs[0]
    $restArgs = if ($allArgs.Count -gt 1) { $allArgs[1..($allArgs.Count - 1)] } else { @() }

    switch ($command) {
        "update" {
            $forceFlag = $restArgs -contains "-f" -or $restArgs -contains "--force"
            Invoke-Update -Force:$forceFlag
        }
        "uninstall" {
            $forceFlag = $restArgs -contains "-f" -or $restArgs -contains "--force"
            Invoke-Uninstall -Force:$forceFlag
        }
        "version" {
            $checkFlag = $restArgs -contains "-c" -or $restArgs -contains "--check"
            Show-Version -Check:$checkFlag
        }
        default {
            Invoke-PassThrough -Arguments $allArgs
        }
    }
}

Main @args

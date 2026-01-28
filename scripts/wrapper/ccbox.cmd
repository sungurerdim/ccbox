<# :
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~f0" %*
exit /b %errorlevel%
#>

# ccbox wrapper for Windows (polyglot CMD/PowerShell)
# Handles: update, uninstall, version
# Everything else: pass-through to ccbox-bin.exe

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Repo = "sungurerdim/ccbox"
$GitHubApi = "https://api.github.com/repos/$Repo/releases/latest"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$CcboxBin = Join-Path $ScriptDir "ccbox-bin.exe"

# --- Helpers ---

function Get-CurrentVersion {
    if (Test-Path $CcboxBin) {
        try {
            $output = & $CcboxBin --version 2>$null
            if ($output -match "(\d+\.\d+\.\d+)") { return "v$($Matches[1])" }
            return $output
        } catch { return "unknown" }
    }
    return "not installed"
}

function Get-LatestVersion {
    try {
        $response = Invoke-RestMethod -Uri $GitHubApi -Headers @{ "User-Agent" = "ccbox" }
        return $response.tag_name
    } catch { return $null }
}

function Compare-SemVer {
    param([string]$a, [string]$b)
    $a = $a -replace "^v", ""
    $b = $b -replace "^v", ""
    if ($a -eq $b) { return 0 }
    $pa = $a.Split('.') | ForEach-Object { [int]$_ }
    $pb = $b.Split('.') | ForEach-Object { [int]$_ }
    $max = [Math]::Max($pa.Count, $pb.Count)
    for ($i = 0; $i -lt $max; $i++) {
        $na = if ($i -lt $pa.Count) { $pa[$i] } else { 0 }
        $nb = if ($i -lt $pb.Count) { $pb[$i] } else { 0 }
        if ($na -gt $nb) { return 1 }
        if ($na -lt $nb) { return -1 }
    }
    return 0
}

# --- Commands ---

function Invoke-Update {
    param([switch]$Force)

    $current = Get-CurrentVersion
    Write-Host "  Checking for updates..." -ForegroundColor DarkGray

    $latest = Get-LatestVersion
    if (-not $latest) {
        Write-Host "  Failed to check (network error or rate limited)" -ForegroundColor Red
        exit 1
    }

    Write-Host ""
    Write-Host "  Current  " -NoNewline -ForegroundColor DarkGray
    Write-Host $current
    Write-Host "  Latest   " -NoNewline -ForegroundColor DarkGray
    Write-Host $latest

    if ((Compare-SemVer $current $latest) -ge 0) {
        Write-Host ""
        Write-Host "  Already up to date" -ForegroundColor Green
        return
    }

    if (-not $Force) {
        Write-Host ""
        $answer = Read-Host "  Update to $latest? [Y/n]"
        if ($answer -match "^[nN]") {
            Write-Host "  Cancelled." -ForegroundColor DarkGray
            return
        }
    }

    $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
    $binaryName = "ccbox-bin-$latest-windows-$arch.exe"
    $url = "https://github.com/$Repo/releases/download/$latest/$binaryName"

    Write-Host "  Downloading ..." -NoNewline
    $tmpFile = [System.IO.Path]::GetTempFileName()
    $bakFile = "$CcboxBin.bak"

    try {
        Invoke-WebRequest -Uri $url -OutFile $tmpFile -UseBasicParsing
        if (Test-Path $CcboxBin) { Move-Item $CcboxBin $bakFile -Force }
        Move-Item $tmpFile $CcboxBin -Force
        if (Test-Path $bakFile) { Remove-Item $bakFile -Force }
        Write-Host " done" -ForegroundColor Green
        Write-Host ""
        Write-Host "  Updated to $latest" -ForegroundColor Green
    } catch {
        Write-Host " failed" -ForegroundColor Red
        if (Test-Path $bakFile) { Move-Item $bakFile $CcboxBin -Force }
        throw
    } finally {
        if (Test-Path $tmpFile) { Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue }
    }
}

function Invoke-Uninstall {
    param([switch]$Force)

    $wrapperCmd = Join-Path $ScriptDir "ccbox.cmd"

    Write-Host ""
    Write-Host "  This will remove:" -ForegroundColor Yellow
    Write-Host "    $CcboxBin"
    Write-Host "    $wrapperCmd"
    Write-Host ""

    if (-not $Force) {
        $answer = Read-Host "  Continue? [y/N]"
        if ($answer -notmatch "^[yY]") {
            Write-Host "  Cancelled." -ForegroundColor DarkGray
            return
        }
    }

    if (Test-Path $CcboxBin) { Remove-Item $CcboxBin -Force }
    if (Test-Path $wrapperCmd) { Remove-Item $wrapperCmd -Force }

    Write-Host ""
    Write-Host "  ccbox has been uninstalled" -ForegroundColor Green
}

function Show-Version {
    param([switch]$Check)

    $current = Get-CurrentVersion
    Write-Host "  ccbox $current"

    if ($Check) {
        Write-Host ""
        Write-Host "  Checking for updates..." -ForegroundColor DarkGray
        $latest = Get-LatestVersion
        if (-not $latest) {
            Write-Host "  Could not check (network error)" -ForegroundColor Yellow
            return
        }
        if ((Compare-SemVer $current $latest) -ge 0) {
            Write-Host "  Up to date" -ForegroundColor Green
        } else {
            Write-Host "  Update available: $current -> $latest" -ForegroundColor Yellow
            Write-Host "  Run 'ccbox update' to update" -ForegroundColor DarkGray
        }
    }
}

function Invoke-PassThrough {
    param([string[]]$Arguments)
    if (-not (Test-Path $CcboxBin)) {
        Write-Host "  ccbox-bin.exe not found" -ForegroundColor Red
        Write-Host "  Run 'ccbox update' to install" -ForegroundColor DarkGray
        exit 1
    }
    & $CcboxBin @Arguments
    exit $LASTEXITCODE
}

# --- Main ---

if ($args.Count -eq 0) {
    Invoke-PassThrough -Arguments @()
}

$command = $args[0]
$rest = if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() }

switch ($command) {
    "update" {
        $f = $rest -contains "-f" -or $rest -contains "--force"
        Invoke-Update -Force:$f
    }
    "uninstall" {
        $f = $rest -contains "-f" -or $rest -contains "--force"
        Invoke-Uninstall -Force:$f
    }
    "version" {
        $c = $rest -contains "-c" -or $rest -contains "--check"
        Show-Version -Check:$c
    }
    default {
        Invoke-PassThrough -Arguments $args
    }
}

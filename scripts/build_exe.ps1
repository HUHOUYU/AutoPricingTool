param(
    [string]$ExeName = "AutoPricingTool"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$distDir = Join-Path $projectRoot "dist-electron"
$portableExe = Join-Path $distDir "$ExeName.exe"
$processorExe = Join-Path $projectRoot "processor-rust\target\release\auto-pricing-tool-processor.exe"
$releaseDir = Join-Path $projectRoot "dist-release"

function Remove-PathIfExists {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

function Stop-ProjectProcessor {
    if (-not (Test-Path -LiteralPath $processorExe)) {
        return
    }

    $processorPath = (Resolve-Path -LiteralPath $processorExe).Path
    $processes = Get-CimInstance Win32_Process |
        Where-Object { $_.ExecutablePath -eq $processorPath }

    foreach ($process in $processes) {
        Stop-Process -Id $process.ProcessId -Force
    }
}

Push-Location $projectRoot
try {
    Stop-ProjectProcessor
    powershell -ExecutionPolicy Bypass -File (Join-Path $projectRoot "scripts\build_processor.ps1")
    npm run build
    npx electron-builder --win portable --x64
} finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $portableExe)) {
    throw "Build output not found: $portableExe"
}
if (-not (Test-Path -LiteralPath $processorExe)) {
    throw "Rust processor output not found: $processorExe"
}

Get-ChildItem -LiteralPath $projectRoot -File -Filter "AutoPricingTool*.exe" |
    Remove-Item -Force
Get-ChildItem -LiteralPath $projectRoot -File -Filter "AutoPricingTool*.zip" |
    Remove-Item -Force
Remove-PathIfExists -Path $releaseDir

Get-ChildItem -LiteralPath $distDir -Directory -Filter "win-unpacked*" -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force

Write-Host "outDir: $distDir"

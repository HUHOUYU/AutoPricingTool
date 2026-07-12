param(
    [switch]$Dev,
    [switch]$Check,
    [switch]$Test
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$processorRoot = Join-Path $projectRoot "processor-rust"
$vcvars = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    $cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
    $env:Path = "$cargoBin;$env:Path"
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw "Cargo not found. Install Rust with: winget install --id Rustlang.Rustup -e"
}

$cargoCommand = if ($Test) {
    "cargo test --all-targets --locked"
} elseif ($Check) {
    "cargo check --all-targets --locked"
} elseif ($Dev) {
    "cargo build --locked"
} else {
    "cargo build --release --locked"
}

if (Test-Path $vcvars) {
    cmd /c "call `"$vcvars`" && cd /d `"$processorRoot`" && $cargoCommand"
    $cargoExitCode = $LASTEXITCODE
} else {
    Push-Location $processorRoot
    try {
        Invoke-Expression $cargoCommand
        $cargoExitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
}

if ($cargoExitCode -ne 0) {
    exit $cargoExitCode
}

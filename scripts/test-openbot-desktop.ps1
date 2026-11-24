[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $Installer
)

$ErrorActionPreference = 'Stop'
$installerPath = (Get-Item -LiteralPath $Installer).FullName
$expected = (Get-Content -LiteralPath "${installerPath}.sha256" -Raw).Trim() -split '\s+', 2
if ($expected[0] -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $installerPath).Hash) {
    throw 'Installer SHA-256 does not match the release checksum.'
}

$scratch = Join-Path ([IO.Path]::GetTempPath()) ('openbot-desktop-smoke-' + [guid]::NewGuid().ToString('N'))
$installation = Join-Path $scratch 'Application with spaces'
$profile = Join-Path $scratch 'Profile with spaces'
New-Item -ItemType Directory -Path $profile | Out-Null
Write-Output "Smoke test files: $scratch"

function Invoke-TestProcess {
    param([string] $Executable, [string[]] $Arguments)
    $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WindowStyle Hidden -PassThru
    try {
        if (!$process.WaitForExit(180000)) {
            $process.Kill()
            throw "Timed out waiting for $([IO.Path]::GetFileName($Executable))."
        }
        if ($process.ExitCode -ne 0) {
            $result = Join-Path $profile 'smoke-result.json'
            if (Test-Path -LiteralPath $result) { Get-Content -LiteralPath $result | Write-Host }
            throw "$([IO.Path]::GetFileName($Executable)) returned exit code $($process.ExitCode)."
        }
    }
    finally {
        $process.Dispose()
    }
}

$location = '"' + $installation + '"'
Invoke-TestProcess $installerPath @('--install', '--location', $location)
$app = Join-Path $installation 'OpenBotFree.exe'
$sidecar = Join-Path $installation 'runtime\OpenBotLocal.exe'
$playwright = Join-Path $installation 'runtime\resources\playwright-core\index.js'
foreach ($file in @($app, $sidecar, $playwright)) {
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing installed file: $file" }
}

Invoke-TestProcess $app @('--smoke-test', ('"' + $profile + '"'))
$smoke = Get-Content -Raw -LiteralPath (Join-Path $profile 'smoke-result.json') | ConvertFrom-Json
if (!$smoke.workspaceLoaded -or !$smoke.downloadAvailable -or !$smoke.backendExitedGracefully) {
    throw "Desktop smoke test failed: $($smoke | ConvertTo-Json -Compress)"
}
$smoke | ConvertTo-Json -Compress

Invoke-TestProcess $installerPath @('--install', '--location', $location)
if (!(Test-Path -LiteralPath $app -PathType Leaf)) { throw 'The app is missing after upgrade.' }
Invoke-TestProcess $installerPath @('--uninstall', '--location', $location)
if ((Test-Path -LiteralPath $installation) -or !(Test-Path -LiteralPath $profile)) {
    throw 'Uninstall did not remove only the application files.'
}
Write-Output 'Checksum, installation, WebView2, download, shutdown, upgrade and uninstall passed.'

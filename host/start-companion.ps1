$ErrorActionPreference = 'Stop'
$created = $false
$mutex = New-Object System.Threading.Mutex($false, 'Local\CLIProxyOpenCodeCompanion', [ref]$created)
if (-not $mutex.WaitOne(0, $false)) { $mutex.Dispose(); exit 0 }
try {
  $nodePath = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  while (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'disabled'))) {
    $process = Start-Process -FilePath $nodePath -ArgumentList ('"' + (Join-Path $PSScriptRoot 'gateway.js') + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $PSScriptRoot 'last-error.log')
    $process.Id | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'gateway.pid')
    $process.WaitForExit()
    Start-Sleep -Seconds 10
  }
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }

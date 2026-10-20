param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-process-owner.cs')
    $request = Get-Content -LiteralPath $RequestFile -Raw | ConvertFrom-Json
    $code = [WindowsProcessOwner]::Run([string]$request.executable, [string[]]$request.arguments,
        [string]$request.cwd, [int]$request.parentPid, [string]$request.stopFile, [string]$request.resultFile)
    exit $code
} catch {
    [Console]::Error.WriteLine('ENGINE_OWNER_FAILED')
    exit 2
}

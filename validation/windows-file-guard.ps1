$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$guard = $null
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-file-guard.cs')
    $request = [Console]::ReadLine() | ConvertFrom-Json
    $guard = [WindowsFileGuard]::new()
    if ($request.mode -eq 'capture') {
        $value = $guard.Capture([string]$request.root)
        [Console]::WriteLine(($value | ConvertTo-Json -Depth 6 -Compress))
    } elseif ($request.mode -eq 'apply') {
        $expected = if ($null -eq $request.expected) {$null} else {[string]$request.expected}
        $guard.Prepare([string]$request.root, [string]$request.relative, $expected, $null -eq $request.expected)
        if ($guard.status -eq 'conflict') {
            [Console]::WriteLine('{"status":"conflict"}')
        } else {
            [Console]::WriteLine('{"status":"locked"}')
            if ([Console]::ReadLine() -ne 'APPLY') {throw 'GUARD_CANCELLED'}
            [byte[]]$bytes = @()
            if ($null -ne $request.base64) {$bytes = [Convert]::FromBase64String([string]$request.base64)}
            $guard.Apply($bytes, $null -eq $request.base64)
            $guard.Dispose(); $guard = $null
            [Console]::WriteLine('{"status":"applied"}')
        }
    } else {throw 'GUARD_MODE_REFUSED'}
} catch {
    # Do not print source paths, source content, requests or runtime stack traces.
    $code = 'GUARD_FAILED'
    $exception = $_.Exception
    while ($null -ne $exception) {
        if ($exception.Message -match '^GUARD_[A-Z_]+$') {$code = $exception.Message; break}
        $exception = $exception.InnerException
    }
    [Console]::WriteLine((@{status='refused'; code=$code} | ConvertTo-Json -Compress))
    exit 2
} finally {if ($null -ne $guard) {$guard.Dispose()}}

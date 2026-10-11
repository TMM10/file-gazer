param([string]$BaseUrl = 'http://127.0.0.1:47841')
$ErrorActionPreference = 'Stop'
$fixtureRoot = Join-Path $PSScriptRoot ('longpath-fixture-' + [guid]::NewGuid().ToString('N'))
$deepFolder = $fixtureRoot
$completedChecks = [System.Collections.Generic.List[string]]::new()
function Assert-Atlas($condition, [string]$description) {
    if (-not $condition) { throw "Failed: $description" }
    $completedChecks.Add($description)
}
try {
    for ($index = 0; $index -lt 6; $index++) {
        $deepFolder = Join-Path $deepFolder (('deep-' + $index + '-') + ('x' * 45))
    }
    [System.IO.Directory]::CreateDirectory($deepFolder) | Out-Null
    $leafPath = Join-Path $deepFolder 'Reference-snow.txt'
    [System.IO.File]::WriteAllBytes($leafPath, [byte[]]::new(113))
    Assert-Atlas ($leafPath.Length -gt 260) 'Fixture leaf exceeds legacy MAX_PATH'
    $scanBody = @{ paths = @($fixtureRoot, $deepFolder) } | ConvertTo-Json
    $scan = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/scan" -ContentType 'application/json' -Body $scanBody
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 100
        $status = Invoke-RestMethod -Uri "$BaseUrl/api/status"
    } while ($status.state -eq 'running' -and [DateTime]::UtcNow -lt $deadline)
    Assert-Atlas ($status.state -eq 'complete' -and $status.bytes -eq 113 -and $status.files -eq 1) 'Native enumeration includes long-path file with exact bytes'
    $overview = Invoke-RestMethod -Uri "$BaseUrl/api/overview"
    Assert-Atlas ($overview.roots.Count -eq 1) 'Overlapping scan roots deduplicate'
    $leafNode = Invoke-RestMethod -Uri ($BaseUrl + '/api/node?path=' + [Uri]::EscapeDataString($leafPath))
    Assert-Atlas ($leafNode.kind -eq 'file' -and $leafNode.size -eq 113) 'Long-path leaf API reports file kind and bytes'
    $folderNode = Invoke-RestMethod -Uri ($BaseUrl + '/api/node?path=' + [Uri]::EscapeDataString($deepFolder))
    Assert-Atlas ($folderNode.children.Count -eq 1 -and $folderNode.children[0].path -eq $leafPath) 'Long-path folder drilldown retains exact path'
    $search = Invoke-RestMethod -Uri "$BaseUrl/api/search?extension=.txt"
    Assert-Atlas ($search.total -eq 1 -and $search.items[0].path -eq $leafPath) 'Long-path file appears in type search'
    $export = Invoke-RestMethod -Uri "$BaseUrl/api/export"
    $node = $export.roots[0]
    for ($index = 0; $index -lt 6; $index++) { $node = $node.children[0] }
    Assert-Atlas ($node.children[0].path -eq $leafPath -and $node.children[0].size -eq 113) 'Long-path hierarchy exports fully'
    try {
        Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/cancel" -Headers @{ Origin = 'https://example.com' } -Body '{}' -ContentType 'application/json' | Out-Null
        throw 'Cross-origin request unexpectedly accepted'
    } catch {
        Assert-Atlas ($_.Exception.Response.StatusCode.value__ -eq 403) 'Foreign website Origin is rejected'
    }
    $processBefore = @(Get-Process -Name FileGazer).Count
    $repeated = Start-Process -FilePath (Join-Path (Split-Path $PSScriptRoot -Parent) 'FileGazer.exe') -ArgumentList @('--no-browser', ('--port=' + ([Uri]$BaseUrl).Port)) -WindowStyle Hidden -Wait -PassThru
    Assert-Atlas ($repeated.ExitCode -eq 0 -and @(Get-Process -Name FileGazer).Count -eq $processBefore) 'Repeated launch reuses existing local service'
    $completedChecks | ForEach-Object { Write-Output "PASS: $_" }
    Write-Output "$($completedChecks.Count) checks passed."
} finally {
    $resolvedFixture = [System.IO.Path]::GetFullPath($fixtureRoot)
    $allowedParent = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\'
    if (-not $resolvedFixture.StartsWith($allowedParent, [StringComparison]::OrdinalIgnoreCase) -or -not (Split-Path $resolvedFixture -Leaf).StartsWith('longpath-fixture-')) {
        throw 'Fixture cleanup target escaped the backend test directory.'
    }
    if (Test-Path -LiteralPath $resolvedFixture) { Remove-Item -LiteralPath $resolvedFixture -Recurse -Force }
}

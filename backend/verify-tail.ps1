param([string]$BaseUrl = 'http://127.0.0.1:47841')
$ErrorActionPreference = 'Stop'
$fixtureRoot = Join-Path $PSScriptRoot ('tail-fixture-' + [guid]::NewGuid().ToString('N'))
$fileCount = 6007
$checks = 0
try {
    [System.IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
    $sizes = [System.Collections.Generic.List[int]]::new()
    for ($index = 0; $index -lt $fileCount; $index++) {
        $size = ($index % 17) + 1
        $sizes.Add($size)
        [System.IO.File]::WriteAllBytes((Join-Path $fixtureRoot ('file-{0:d5}.txt' -f $index)), [byte[]]::new($size))
    }
    $sortedSizes = @($sizes | Sort-Object -Descending)
    $totalSize = ($sizes | Measure-Object -Sum).Sum
    Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/scan" -ContentType 'application/json' -Body (@{ paths = @($fixtureRoot) } | ConvertTo-Json) | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 100
        $status = Invoke-RestMethod -Uri "$BaseUrl/api/status"
    } while ($status.state -eq 'running' -and [DateTime]::UtcNow -lt $deadline)
    if ($status.state -ne 'complete' -or $status.files -ne $fileCount -or $status.bytes -ne $totalSize) { throw 'Large-folder fixture inventory totals differ.' }
    $checks++
    foreach ($offset in @(0, 5001, 6000, 6007, 7000)) {
        $expected = ($sortedSizes | Select-Object -Skip $offset | Measure-Object -Sum).Sum
        if ($null -eq $expected) { $expected = 0 }
        $node = Invoke-RestMethod -Uri ($BaseUrl + '/api/node?path=' + [Uri]::EscapeDataString($fixtureRoot) + '&offset=' + $offset + '&limit=200')
        if ($node.remainingSize -ne $expected -or $node.childrenSizeTotal -ne $totalSize -or $node.totalChildren -ne $fileCount) { throw "Incorrect remainingSize at offset $offset." }
        $checks++
    }
    $filtered = Invoke-RestMethod -Uri ($BaseUrl + '/api/node?path=' + [Uri]::EscapeDataString($fixtureRoot) + '&offset=5001&limit=6000&category=documents')
    $expectedFiltered = ($sortedSizes | Select-Object -Skip 5001 | Measure-Object -Sum).Sum
    $returnedSum = ($filtered.children | Measure-Object -Property size -Sum).Sum
    if ($filtered.remainingSize -ne $expectedFiltered -or $returnedSum -ne $expectedFiltered -or $filtered.limit -ne 5000) { throw 'Filtered, capped large-folder tail sum differs.' }
    $checks++
    Write-Output "$checks checks passed: 6007 files, exact tails at offsets 0/5001/6000/end/past-end, category filtering, and limit capping."
} finally {
    $resolvedFixture = [System.IO.Path]::GetFullPath($fixtureRoot)
    $allowedParent = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\'
    if (-not $resolvedFixture.StartsWith($allowedParent, [StringComparison]::OrdinalIgnoreCase) -or -not (Split-Path $resolvedFixture -Leaf).StartsWith('tail-fixture-')) { throw 'Unsafe fixture cleanup target.' }
    if (Test-Path -LiteralPath $resolvedFixture) { Remove-Item -LiteralPath $resolvedFixture -Recurse -Force }
}

param([string]$BaseUrl = 'http://127.0.0.1:47841')
$ErrorActionPreference = 'Stop'
if ($BaseUrl -ne 'http://127.0.0.1:47841') { throw 'This native fixture verifier requires the dedicated port 47841.' }
$health = Invoke-RestMethod -Uri "$BaseUrl/api/health"
if ($health.product -ne 'File Gazer' -or $health.version -ne '1.1') { throw 'Start FileGazer.exe --no-browser --port=47841 before this check.' }
$fixtureRoot = Join-Path $PSScriptRoot ('native-fixture-' + [guid]::NewGuid().ToString('N'))
$checks = [System.Collections.Generic.List[string]]::new()
function Assert-Action($condition, [string]$description) { if (-not $condition) { throw "Failed: $description" }; $checks.Add($description) }
function Post-Action([string]$route, $body) { Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/$route" -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 6) }
function Expect-Status([string]$route, $body, [int]$code) {
    try { Post-Action $route $body | Out-Null; throw "Action $route unexpectedly succeeded" }
    catch { if ($_.Exception.Response.StatusCode.value__ -ne $code) { throw "Action $route expected $code, got $($_.Exception.Message)" } }
    $checks.Add("$route rejected with HTTP $code")
}
[System.IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
$definitions = @{ 'Documents\a.txt'=31; 'Documents\nested\data.json'=47; 'trash-one.tmp'=29; 'trash-parent\nested\file.mp4'=63; 'trash-parent\zero.dat'=0; 'remain.png'=17; 'dangerous.exe'=13; 'shortcut.url'=11; 'collision.txt'=5; 'source.txt'=7 }
foreach ($relative in $definitions.Keys) {
    $file = Join-Path $fixtureRoot $relative
    [System.IO.Directory]::CreateDirectory((Split-Path $file -Parent)) | Out-Null
    [System.IO.File]::WriteAllBytes($file, [byte[]]::new($definitions[$relative]))
}
Post-Action 'scan' @{ paths=@($fixtureRoot) } | Out-Null
$deadline = [DateTime]::UtcNow.AddSeconds(30)
do { Start-Sleep -Milliseconds 100; $status = Invoke-RestMethod -Uri "$BaseUrl/api/status" } while ($status.state -eq 'running' -and [DateTime]::UtcNow -lt $deadline)
Assert-Action ($status.state -eq 'complete' -and $status.bytes -eq 223 -and $status.files -eq 10 -and $status.revision -eq 0) 'Fixture-only baseline exact totals'
$source = Join-Path $fixtureRoot 'source.txt'
$renamed = Post-Action 'rename' @{path=$source;name='renamed.jpg'}
$renamedPath = Join-Path $fixtureRoot 'renamed.jpg'
Assert-Action ($renamed.renamed -and $renamed.path -eq $renamedPath -and $renamed.revision -eq 1 -and [System.IO.File]::Exists($renamedPath) -and -not [System.IO.File]::Exists($source)) 'File basename rename changes filesystem and revision'
$images = @($renamed.overview.categories | Where-Object name -eq 'Images')[0]
Assert-Action ($images.size -eq 24 -and $renamed.overview.size -eq 223) 'Renamed file extension updates categories with unchanged total bytes'
Expect-Status 'rename' @{path=$renamedPath;name='collision.txt'} 409
Expect-Status 'rename' @{path=$renamedPath;name='..\escape.txt'} 400
Expect-Status 'rename' @{path=$renamedPath;name='CON.txt'} 400
Expect-Status 'rename' @{path=$fixtureRoot;name='renamed-root'} 403
Expect-Status 'open' @{path=(Join-Path $fixtureRoot 'dangerous.exe')} 403
Expect-Status 'open' @{path=(Join-Path $fixtureRoot 'shortcut.url')} 403
Expect-Status 'open' @{path=(Join-Path $fixtureRoot 'Documents')} 400
Expect-Status 'properties' @{path=(Join-Path $PSScriptRoot 'StorageAtlas.cs')} 404
$folderPath = Join-Path $fixtureRoot 'Documents'
$folderRename = Post-Action 'rename' @{path=$folderPath;name='Windows'}
$system = @($folderRename.overview.categories | Where-Object name -eq 'System')[0]
Assert-Action ($system.size -eq 78 -and $folderRename.overview.size -eq 223) 'Folder rename reclassifies subtree and ancestor category totals'
$windowsPath = Join-Path $fixtureRoot 'Windows'
$jsonSearch = Invoke-RestMethod -Uri "$BaseUrl/api/search?extension=.json"
Assert-Action ($jsonSearch.total -eq 1 -and $jsonSearch.items[0].path -eq (Join-Path $windowsPath 'nested\data.json') -and $jsonSearch.items[0].category -eq 'System') 'Folder rename reindexes descendant search paths'
$restoreName = Post-Action 'rename' @{path=$windowsPath;name='Documents'}
$code = @($restoreName.overview.categories | Where-Object name -eq 'Code')[0]
Assert-Action ($code.size -eq 47) 'Folder category rebuild restores extension classification'
$trashOne = Join-Path $fixtureRoot 'trash-one.tmp'
$trashParent = Join-Path $fixtureRoot 'trash-parent'
Expect-Status 'recycle' @{paths=@($trashOne, (Join-Path $fixtureRoot 'not-in-scan'))} 404
Assert-Action ([System.IO.File]::Exists($trashOne)) 'Invalid batch causes no filesystem mutation'
Expect-Status 'recycle' @{paths=@($trashOne, $fixtureRoot)} 403
Assert-Action ([System.IO.File]::Exists($trashOne)) 'Protected-root batch causes no filesystem mutation'
$recycled = Post-Action 'recycle' @{paths=@($trashOne, $trashOne.ToUpperInvariant(), $trashParent, (Join-Path $trashParent 'nested\file.mp4'))}
Assert-Action ($recycled.recycled.Count -eq 2 -and $recycled.errors.Count -eq 0 -and $recycled.results.Count -eq 2) 'Native recycle confirms Bin destination and deduplicates parents'
Assert-Action (-not [System.IO.File]::Exists($trashOne) -and -not [System.IO.Directory]::Exists($trashParent)) 'Recycled fixture entries leave original locations'
Assert-Action ($recycled.overview.size -eq 131 -and $recycled.overview.files -eq 7 -and $recycled.overview.folders -eq 3 -and $recycled.revision -eq 4) 'Recycle updates exact ancestor/global counters and one batch revision'
$node = Invoke-RestMethod -Uri ($BaseUrl + '/api/node?path=' + [Uri]::EscapeDataString($fixtureRoot))
Assert-Action ($node.childrenSizeTotal -eq 131 -and $node.remainingSize -eq 131 -and $node.revision -eq 4) 'Node aggregate totals and revision reflect native actions'
$categorySum = ($recycled.overview.categories | Measure-Object -Property size -Sum).Sum
$extensionSum = ($recycled.overview.extensions | Measure-Object -Property size -Sum).Sum
Assert-Action ($categorySum -eq 131 -and $extensionSum -eq 131) 'Categories and extensions both sum to retained logical bytes'
try { Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/rename" -Headers @{Origin='https://example.com'} -ContentType 'application/json' -Body (@{path=$renamedPath;name='foreign.jpg'} | ConvertTo-Json) | Out-Null; throw 'Foreign Origin accepted' }
catch { Assert-Action ($_.Exception.Response.StatusCode.value__ -eq 403) 'Foreign website cannot invoke native mutations' }
try { Invoke-RestMethod -Uri "$BaseUrl/api/recycle" | Out-Null; throw 'GET mutation accepted' }
catch { Assert-Action ($_.Exception.Response.StatusCode.value__ -eq 405) 'GET cannot invoke recycle' }
Expect-Status 'rename' @{path=(Join-Path $PSScriptRoot 'StorageAtlas.cs');name='not-permitted.cs'} 404
$deepFolder = $fixtureRoot
for ($index=0; $index -lt 6; $index++) { $deepFolder = Join-Path $deepFolder (('long-' + $index + '-') + ('x' * 45)) }
[System.IO.Directory]::CreateDirectory($deepFolder) | Out-Null
$longOriginal = Join-Path $deepFolder 'long-original.txt'
[System.IO.File]::WriteAllBytes($longOriginal, [byte[]]::new(13))
Post-Action 'scan' @{paths=@($fixtureRoot)} | Out-Null
try { Post-Action 'rename' @{path=$renamedPath;name='during-scan.jpg'} | Out-Null; $runningRenameBlocked=$false }
catch { $runningRenameBlocked=$_.Exception.Response.StatusCode.value__ -eq 409 }
do { Start-Sleep -Milliseconds 100; $status=Invoke-RestMethod -Uri "$BaseUrl/api/status" } while ($status.state -eq 'running')
Assert-Action ($runningRenameBlocked -or $status.state -eq 'complete') 'A running scan blocks mutation or finishes before request'
$longRename = Post-Action 'rename' @{path=$longOriginal;name='long-renamed.png'}
$longRenamed = Join-Path $deepFolder 'long-renamed.png'
Assert-Action ($longRenamed.Length -gt 260 -and $longRename.path -eq $longRenamed -and [System.IO.File]::Exists($longRenamed)) 'Native basename rename supports extended-length paths'
$longTrash = Post-Action 'recycle' @{path=$longRenamed}
Assert-Action (($longTrash.recycled.Count -eq 1 -and -not [System.IO.File]::Exists($longRenamed)) -or ($longTrash.errors.Count -eq 1 -and [System.IO.File]::Exists($longRenamed))) 'Long-path recycling confirms Bin or fails with original intact'
$finalOverview = Invoke-RestMethod -Uri "$BaseUrl/api/overview"
Assert-Action ($finalOverview.size -eq $(if ($longTrash.recycled.Count -eq 1) {131} else {144})) 'Long-path native outcome keeps exact inventory byte totals'
$checks | ForEach-Object { Write-Output "PASS: $_" }
$report = @{ baseUrl=$BaseUrl; passed=$checks.Count; failed=0; checks=@($checks); fixture=$fixtureRoot; longPathLength=$longRenamed.Length; longPathRecycleSucceeded=($longTrash.recycled.Count -eq 1); finalBytes=$finalOverview.size; testedAt=[DateTime]::UtcNow.ToString('o') }
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'native-actions-report.json') -Encoding utf8
Write-Output "$($checks.Count) native action checks passed. Fixture retained at $fixtureRoot; recycled test entries remain in Windows Recycle Bin."

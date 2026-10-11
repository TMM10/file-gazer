param()
$ErrorActionPreference = 'Stop'
$baseUrl = 'http://127.0.0.1:47841'
$source = Join-Path $PSScriptRoot 'StorageAtlas.cs'
$icon = Join-Path (Split-Path $PSScriptRoot -Parent) 'ui\file-gazer.ico'
if (-not (Test-Path -LiteralPath $icon)) { throw 'The File Gazer star icon is missing.' }
$candidateDirectory = Join-Path $PSScriptRoot 'candidate'
$testDirectory = Join-Path $PSScriptRoot 'steam-tests'
$candidate = Join-Path $candidateDirectory 'FileGazer.exe'
$testExecutable = Join-Path $testDirectory 'FileGazer.SteamTest.exe'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
try { $existing = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 2; throw 'Port 47841 already has a service. Stop only an owned isolated service before this verifier.' }
catch { if ($existing) { throw } }
[System.IO.Directory]::CreateDirectory($candidateDirectory) | Out-Null
[System.IO.Directory]::CreateDirectory($testDirectory) | Out-Null
$compileArguments = @('/nologo', '/target:winexe', '/optimize+', '/platform:anycpu', '/reference:System.Web.Extensions.dll', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', "/win32icon:$icon", "/resource:$icon,FileGazer.Icon")
& $compiler @compileArguments "/out:$candidate" $source
if ($LASTEXITCODE -ne 0) { throw 'Production candidate compilation failed.' }
& $compiler @compileArguments '/define:FILEGAZER_STEAM_TEST' "/out:$testExecutable" $source
if ($LASTEXITCODE -ne 0) { throw 'Steam test executable compilation failed.' }
$checks = [System.Collections.Generic.List[string]]::new()
$fixtureRoot = Join-Path $testDirectory ('fixture-' + [guid]::NewGuid().ToString('N'))
$utf8 = [System.Text.UTF8Encoding]::new($false)
function Assert-Steam($condition, [string]$description) { if (-not $condition) { throw "Failed: $description" }; $checks.Add($description) }
function Post-Steam([string]$route, $body) { Invoke-RestMethod -Method Post -Uri "$baseUrl/api/$route" -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 5) }
function Expect-SteamStatus($body, [int]$code) {
    try { Post-Steam 'steam-library' $body | Out-Null; throw 'Steam endpoint unexpectedly succeeded' }
    catch { if ($_.Exception.Response.StatusCode.value__ -ne $code) { throw "Steam endpoint expected $code, got $($_.Exception.Message)" } }
    $checks.Add("Steam endpoint rejects HTTP $code for " + ($body | ConvertTo-Json -Compress))
}
function Scan-Steam([string[]]$paths) {
    Post-Steam 'scan' @{paths=@($paths)} | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do { Start-Sleep -Milliseconds 50; $status = Invoke-RestMethod -Uri "$baseUrl/api/status" } while ($status.state -eq 'running' -and [DateTime]::UtcNow -lt $deadline)
    Assert-Steam ($status.state -eq 'complete') 'Fixture scan completes'
    return Invoke-RestMethod -Uri "$baseUrl/api/overview"
}
function Write-SteamFile([string]$relative, [int]$size) {
    $path = Join-Path $fixtureRoot $relative
    [System.IO.Directory]::CreateDirectory((Split-Path $path -Parent)) | Out-Null
    [System.IO.File]::WriteAllBytes($path, [byte[]]::new($size))
}
function Write-SteamManifest([string]$fileId, $contentId, [string]$directory, [string]$name) {
    $path = Join-Path $fixtureRoot ('steamapps\appmanifest_' + $fileId + '.acf')
    [System.IO.Directory]::CreateDirectory((Split-Path $path -Parent)) | Out-Null
    $idLine = if ($null -ne $contentId) { '"appid" "' + $contentId + '"' } else { '' }
    $text = '"AppState"' + "`r`n{`r`n" + $idLine + "`r`n" + '"name" "' + $name + '"' + "`r`n" + '"installdir" "' + $directory + '"' + "`r`n}`r`n"
    [System.IO.File]::WriteAllText($path, $text, $utf8)
}
Write-SteamManifest '12345' '0000012345' 'Valid' 'Fixture Galaxy'
Write-SteamManifest '4294967295' '4294967295' 'Maximum' 'Maximum ID'
Write-SteamManifest '21' $null 'Legacy' 'Legacy manifest'
Write-SteamManifest '0' '0' 'Zero' 'Zero ID'
Write-SteamManifest '4294967296' '4294967296' 'Overflow' 'Overflow ID'
Write-SteamManifest '5' '-5' 'Negative' 'Negative ID'
Write-SteamManifest '6' 'steam://run/1' 'NonNumeric' 'Non numeric ID'
Write-SteamManifest '777' '612' 'Mismatch' 'Mismatching ID'
$files = @{ 'steamapps\common\Valid\game.bin'=1024; 'steamapps\common\Valid\assets\asset.txt'=17; 'steamapps\common\Maximum\data.bin'=5; 'steamapps\common\Legacy\data.bin'=11; 'steamapps\common\Zero\data.bin'=13; 'steamapps\common\Overflow\data.bin'=19; 'steamapps\common\Negative\data.bin'=23; 'steamapps\common\NonNumeric\data.bin'=29; 'steamapps\common\Mismatch\data.bin'=31; 'steamapps\common\Fallback\orphan.bin'=37; 'plain.txt'=41 }
foreach ($relative in $files.Keys) { Write-SteamFile $relative $files[$relative] }
$expectedBytes = (Get-ChildItem -LiteralPath $fixtureRoot -File -Recurse | Measure-Object -Property Length -Sum).Sum
$expectedFiles = @(Get-ChildItem -LiteralPath $fixtureRoot -File -Recurse).Count
$process = $null
try {
    $process = Start-Process -FilePath $testExecutable -ArgumentList @('--no-browser', '--port=47841') -PassThru -WindowStyle Hidden
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do { Start-Sleep -Milliseconds 100; try { $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 1 } catch { $health=$null } } while (-not $health -and [DateTime]::UtcNow -lt $deadline)
    Assert-Steam ($health.product -eq 'File Gazer') 'Owned Steam test service starts with native launch suppressed at compile time'
    $overview = Scan-Steam @($fixtureRoot)
    Assert-Steam ($overview.size -eq $expectedBytes -and $overview.files -eq $expectedFiles -and $overview.revision -eq 0) 'Full fixture exact file count and logical bytes'
    $valid = @($overview.games | Where-Object name -eq 'Fixture Galaxy')[0]
    $gameRoot = Join-Path $fixtureRoot 'steamapps\common\Valid'
    $assetsRoot = Join-Path $gameRoot 'assets'
    $assetFile = Join-Path $assetsRoot 'asset.txt'
    Assert-Steam ($valid.steamAppId -ceq '12345' -and $valid.path -eq $gameRoot -and $valid.size -eq 1041) 'Valid manifest ID is canonical decimal and keeps exact game bytes'
    $maximum = @($overview.games | Where-Object name -eq 'Maximum ID')[0]
    Assert-Steam ($maximum.steamAppId -ceq '4294967295') 'Positive UInt32 maximum is supported'
    foreach ($name in @('Legacy manifest','Zero ID','Overflow ID','Negative ID','Non numeric ID','Mismatching ID','Fallback')) {
        $game = @($overview.games | Where-Object name -eq $name)[0]
        Assert-Steam ($null -ne $game -and $null -eq $game.PSObject.Properties['steamAppId']) "$name keeps classification without a Steam launch ID"
        Expect-SteamStatus @{path=$game.path} 404
    }
    foreach ($path in @($gameRoot, $assetsRoot, $assetFile)) {
        $opened = Post-Steam 'steam-library' @{path=$path}
        Assert-Steam ($opened.opened -eq $true -and $opened.steamAppId -ceq '12345') 'Recognized scanned game, folder, or file resolves the same Steam library ID'
    }
    $openedMaximum = Post-Steam 'steam-library' @{path=$maximum.path}
    Assert-Steam ($openedMaximum.opened -and $openedMaximum.steamAppId -ceq '4294967295') 'Maximum manifest ID passes endpoint validation'
    Expect-SteamStatus @{path=$fixtureRoot} 404
    Expect-SteamStatus @{path=(Join-Path $fixtureRoot 'plain.txt')} 404
    Expect-SteamStatus @{path=(Join-Path $fixtureRoot 'steamapps\common\Valid-extra')} 404
    Expect-SteamStatus @{path=(Join-Path $PSScriptRoot 'StorageAtlas.cs')} 404
    Expect-SteamStatus @{path=$gameRoot;appid='999';url='steam://run/999'} 400
    Expect-SteamStatus @{appid='12345'} 400
    Expect-SteamStatus @{path=12345} 400
    try { Invoke-RestMethod -Uri "$baseUrl/api/steam-library" | Out-Null; throw 'GET Steam launch accepted' }
    catch { Assert-Steam ($_.Exception.Response.StatusCode.value__ -eq 405) 'GET cannot open a Steam library page' }
    try { Invoke-RestMethod -Method Post -Uri "$baseUrl/api/steam-library" -Headers @{Origin='https://example.com'} -ContentType 'application/json' -Body (@{path=$gameRoot} | ConvertTo-Json) | Out-Null; throw 'Foreign Origin Steam launch accepted' }
    catch { Assert-Steam ($_.Exception.Response.StatusCode.value__ -eq 403) 'Foreign Origin cannot invoke the Steam protocol' }
    $afterOpen = Invoke-RestMethod -Uri "$baseUrl/api/overview"
    Assert-Steam ($afterOpen.size -eq $expectedBytes -and $afterOpen.files -eq $expectedFiles -and $afterOpen.revision -eq 0) 'Opening Steam leaves inventory, files, and revision unchanged'
    $partial = Scan-Steam @($assetsRoot)
    Assert-Steam ($partial.size -eq 17 -and $partial.games.Count -eq 1 -and $partial.games[0].steamAppId -ceq '12345' -and $partial.games[0].path -eq $assetsRoot -and $partial.games[0].installationPath -eq $gameRoot) 'Partial game-root scan preserves recognized manifest ID and clickable selected path'
    $partialOpened = Post-Steam 'steam-library' @{path=$assetFile}
    Assert-Steam ($partialOpened.steamAppId -ceq '12345') 'Partial-root scanned file resolves unscanned Steam installation ancestor'
    Expect-SteamStatus @{path=$gameRoot} 404
    Expect-SteamStatus @{path=(Join-Path $gameRoot 'game.bin')} 404
    $export = Invoke-RestMethod -Uri "$baseUrl/api/export"
    Assert-Steam ($export.games[0].steamAppId -ceq '12345' -and $export.roots[0].size -eq 17) 'Export preserves optional Steam metadata and exact bytes'
    $overview = Scan-Steam @($fixtureRoot)
    $renamed = Post-Steam 'rename' @{path=$gameRoot;name='Renamed Valid'}
    $renamedGameRoot = Join-Path $fixtureRoot 'steamapps\common\Renamed Valid'
    $renamedGame = @($renamed.overview.games | Where-Object steamAppId -eq '12345')[0]
    Assert-Steam ($renamedGame.path -eq $renamedGameRoot -and $renamedGame.installationPath -eq $renamedGameRoot -and $renamedGame.size -eq 1041 -and $renamed.revision -eq 1) 'Owned fixture game rename retains Steam ID and moves registered paths'
    $renamedOpened = Post-Steam 'steam-library' @{path=(Join-Path $renamedGameRoot 'assets\asset.txt')}
    Assert-Steam ($renamedOpened.steamAppId -ceq '12345') 'Renamed scanned descendant resolves retained Steam ID'
    Expect-SteamStatus @{path=$assetFile} 404
    $final = Invoke-RestMethod -Uri "$baseUrl/api/overview"
    Assert-Steam ($final.size -eq $expectedBytes -and ($final.categories | Measure-Object -Property size -Sum).Sum -eq $expectedBytes -and ($final.extensions | Measure-Object -Property size -Sum).Sum -eq $expectedBytes) 'Steam metadata and fixture rename preserve all exact aggregate totals'
    $fixtureAbsolute = [System.IO.Path]::GetFullPath($fixtureRoot)
    $testAbsolute = [System.IO.Path]::GetFullPath($testDirectory).TrimEnd('\') + '\'
    if (-not $fixtureAbsolute.StartsWith($testAbsolute, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $fixtureAbsolute -Leaf) -notmatch '^fixture-[0-9a-f]{32}$') { throw 'Refusing fixture cleanup outside the owned Steam test directory.' }
    Scan-Steam @($testDirectory) | Out-Null
    $fixtureRecycle = Post-Steam 'recycle' @{path=$fixtureAbsolute}
    Assert-Steam ($fixtureRecycle.recycled.Count -eq 1 -and $fixtureRecycle.errors.Count -eq 0 -and -not (Test-Path -LiteralPath $fixtureAbsolute)) 'Owned Steam fixture moves to Recycle Bin with native confirmation'
    $report = @{passed=$checks.Count;failed=0;checks=@($checks);fixture=$fixtureRoot;fixtureRetained=$false;fixtureRecycled=$true;candidate=$candidate;nativeSteamLaunchSuppressed=$true;finalBytes=$final.size;finalFiles=$final.files;testedAt=[DateTime]::UtcNow.ToString('o')}
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'steam-report.json') -Encoding utf8
    $checks | ForEach-Object { Write-Output "PASS: $_" }
    Write-Output "$($checks.Count) Steam fixture checks passed. No real Steam launch or normal service access occurred."
}
finally {
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id; $process.WaitForExit(5000) | Out-Null }
}

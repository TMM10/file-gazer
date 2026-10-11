param()
$ErrorActionPreference = 'Stop'
$baseUrl = 'http://127.0.0.1:47842'
$appRoot = Split-Path $PSScriptRoot -Parent
$candidate = Join-Path $PSScriptRoot 'candidate\FileGazer.exe'
$source = Join-Path $PSScriptRoot 'StorageAtlas.cs'
$icon = Join-Path $appRoot 'ui\file-gazer.ico'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$testRoot = Join-Path $PSScriptRoot ('library-tests\fixture-' + [guid]::NewGuid().ToString('N'))
$serviceRoot = Join-Path $testRoot 'service'
$fixture = Join-Path $testRoot 'inventory'
$settings = Join-Path $serviceRoot 'game-libraries-47842.json'
$testExe = Join-Path $serviceRoot 'FileGazer.exe'
$helperExe = Join-Path $testRoot 'LibraryChecks.exe'
$checks = [System.Collections.Generic.List[string]]::new()
$process = $null
$existing = $null
try { $existing = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 1 } catch { }
if ($existing) { throw 'Port 47842 is occupied; do not interrupt that instance.' }
[System.IO.Directory]::CreateDirectory((Split-Path $candidate -Parent)) | Out-Null
[System.IO.Directory]::CreateDirectory($serviceRoot) | Out-Null
[System.IO.Directory]::CreateDirectory($fixture) | Out-Null
$compileArgs = @('/nologo','/target:winexe','/optimize+','/platform:anycpu','/r:System.Web.Extensions.dll','/r:System.Windows.Forms.dll','/r:System.Drawing.dll',"/win32icon:$icon","/resource:$icon,FileGazer.Icon")
& $compiler @compileArgs "/out:$candidate" $source
if ($LASTEXITCODE -ne 0) { throw 'Production candidate compile failed.' }
[System.IO.File]::Copy($candidate, $testExe)
& $compiler /nologo /target:exe /r:System.Web.Extensions.dll "/out:$helperExe" (Join-Path $PSScriptRoot 'verify-game-libraries.cs')
if ($LASTEXITCODE -ne 0) { throw 'Read-only inventory helper compile failed.' }
function Assert-Library($condition, [string]$description) { if (-not $condition) { throw "Failed: $description" }; $checks.Add($description) }
function Post-Library([string]$route, $body) { Invoke-RestMethod -Uri "$baseUrl/api/$route" -Method Post -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 6) }
function Get-Library([string]$route) { Invoke-RestMethod -Uri "$baseUrl/api/$route" }
function Expect-Library([string]$route, $body, [int]$code, [string]$description) {
    try { Post-Library $route $body | Out-Null; throw 'Unexpected success.' }
    catch { if ($_.Exception.Response.StatusCode.value__ -ne $code) { throw "Expected HTTP $code for $description, got $($_.Exception.Message)" } }
    $checks.Add($description)
}
function Scan-Library([string[]]$paths) {
    Post-Library 'scan' @{paths=@($paths)} | Out-Null
    $deadline=[DateTime]::UtcNow.AddSeconds(30)
    do { Start-Sleep -Milliseconds 50; $s=Get-Library 'status' } while ($s.state -eq 'running' -and [DateTime]::UtcNow -lt $deadline)
    Assert-Library ($s.state -eq 'complete') 'Owned fixture scan completes'
    Get-Library 'overview'
}
function Start-Library {
    $script:process=Start-Process -FilePath $testExe -ArgumentList @('--no-browser','--port=47842') -PassThru -WindowStyle Hidden
    $deadline=[DateTime]::UtcNow.AddSeconds(10); $health=$null
    do { Start-Sleep -Milliseconds 100; try { $health=Get-Library 'health' } catch { } } while (-not $health -and [DateTime]::UtcNow -lt $deadline)
    Assert-Library ($health.product -eq 'File Gazer' -and $health.port -eq 47842) 'Isolated production service starts on 47842'
}
function Stop-Library {
    if ($script:process -and -not $script:process.HasExited) {
        $owned=Get-Process -Id $script:process.Id -ErrorAction SilentlyContinue
        if ($owned.Path -ne $testExe) { throw 'Owned test executable identity changed; refusing to stop it.' }
        Stop-Process -Id $script:process.Id
        $script:process.WaitForExit(5000) | Out-Null
    }
    $script:process=$null
}
function Write-Library([string]$relative,[int]$bytes) {
    $file=Join-Path $fixture $relative; [System.IO.Directory]::CreateDirectory((Split-Path $file -Parent)) | Out-Null
    [System.IO.File]::WriteAllBytes($file,[byte[]]::new($bytes))
}
function Category-Library($overview,[string]$name) { @($overview.categories | Where-Object name -eq $name)[0] }
function Shape-Library($overview) { (@($overview.categories | ForEach-Object { "$($_.name):$($_.size):$($_.files)" }) -join '|') }
function Extensions-Library($overview) { (@($overview.extensions | Sort-Object name | ForEach-Object { "$($_.name):$($_.size):$($_.files)" }) -join '|') }
$files=@{
    'Manual\Alpha\readme.txt'=103; 'Manual\Alpha\assets\asset.png'=101; 'Manual\Beta\movie.mp4'=211;
    'Manual\loose.txt'=17; 'Manual\loose.png'=19; 'Other\docs.pdf'=29; 'Other\photo.jpg'=31;
    'XboxGames\Known One\data.bin'=307; 'Steam\steamapps\common\Folder\readme.txt'=401;
    'Steam\steamapps\common\Folder\assets\asset.bin'=209; 'Ambiguous\Child\XboxGames\Nested Game\data.bin'=11;
    'SimpleRoot\One\file.txt'=53
}
foreach ($file in $files.Keys) { Write-Library $file $files[$file] }
foreach ($folder in @('Manual\Empty','Manual\Alpha\Nested','XboxGames\Empty Known','Steam\steamapps\common\Empty Steam','SimpleRoot\Empty')) { [System.IO.Directory]::CreateDirectory((Join-Path $fixture $folder)) | Out-Null }
$manifest='"AppState"' + "`r`n{`r`n" + '"appid" "12345"' + "`r`n" + '"name" "Manifest Title"' + "`r`n" + '"installdir" "Folder"' + "`r`n}`r`n"
[System.IO.File]::WriteAllText((Join-Path $fixture 'Steam\steamapps\appmanifest_12345.acf'),$manifest,[System.Text.UTF8Encoding]::new($false))
$manual=Join-Path $fixture 'Manual'; $alpha=Join-Path $manual 'Alpha'; $beta=Join-Path $manual 'Beta'
$xbox=Join-Path $fixture 'XboxGames'; $common=Join-Path $fixture 'Steam\steamapps\common'; $simple=Join-Path $fixture 'SimpleRoot'
$baselineFiles=@(Get-ChildItem -LiteralPath $fixture -File -Recurse)
$expectedBytes=($baselineFiles | Measure-Object Length -Sum).Sum
try {
    Start-Library
    $baseline=Scan-Library @($fixture)
    Assert-Library ($baseline.size -eq $expectedBytes -and $baseline.files -eq $baselineFiles.Count) 'Baseline exact logical bytes and files'
    Assert-Library (@($baseline.gameLibraries).Count -eq 0) 'New isolated instance has no saved personal libraries'
    $baselineShape=Shape-Library $baseline; $baselineExt=Extensions-Library $baseline
    $baseGames=(Category-Library $baseline 'Games').size
    $marked=Post-Library 'game-library' @{path=$manual;enabled=$true}
    $overview=$marked.overview
    Assert-Library ($marked.enabled -and $marked.revision -eq 1 -and $overview.gameLibraries[0] -eq $manual) 'Mark persists canonical folder and increments revision once'
    Assert-Library ($overview.size -eq $baseline.size -and $overview.files -eq $baseline.files -and $overview.folders -eq $baseline.folders -and (Extensions-Library $overview) -ceq $baselineExt) 'Mark leaves total bytes, files, folders, and extension totals unchanged'
    Assert-Library ((Category-Library $overview 'Games').size -eq $baseGames+415) 'Immediate child games move exactly 415 bytes into Games'
    $manualRows=@($overview.games | Where-Object libraryPath -eq $manual)
    Assert-Library ($manualRows.Count -eq 3 -and ($manualRows | Measure-Object size -Sum).Sum -eq 415) 'Each immediate child appears once with disjoint aggregate bytes'
    Assert-Library (@($manualRows | Where-Object { $_.name -eq 'Empty' -and $_.size -eq 0 -and $_.files -eq 0 }).Count -eq 1) 'Empty custom child remains a zero-byte Games row'
    $manualNode=Get-Library ('node?path='+[Uri]::EscapeDataString($manual))
    Assert-Library (@($manualNode.children | Where-Object { $_.name -eq 'loose.txt' -and $_.category -eq 'Documents' }).Count -eq 1 -and @($manualNode.children | Where-Object { $_.name -eq 'loose.png' -and $_.category -eq 'Images' }).Count -eq 1) 'Loose files in a marked library retain their original categories'
    $gameNode=Get-Library ('node?path='+[Uri]::EscapeDataString($fixture)+'&category=Games')
    Assert-Library ($gameNode.size -eq $baseGames+415 -and $gameNode.childrenSizeTotal -eq $gameNode.size) 'Ancestor category aggregates rebuild exactly'
    Assert-Library (($overview.categories | Measure-Object size -Sum).Sum -eq $overview.size -and ($overview.categories | Measure-Object files -Sum).Sum -eq $overview.files) 'Category sizes and file counts remain mutually exclusive'
    $same=Post-Library 'game-library' @{path=$manual.ToUpperInvariant();enabled=$true}
    Assert-Library ($same.revision -eq 1 -and $same.path -ceq $manual) 'Case-insensitive idempotent marking preserves canonical path and revision'
    Expect-Library 'game-library' @{path=$alpha;enabled=$true} 409 'Nested library declaration is rejected'
    Expect-Library 'game-library' @{path=$fixture;enabled=$true} 409 'Ancestor library declaration is rejected'
    Expect-Library 'game-library' @{path=(Join-Path $fixture 'Ambiguous');enabled=$true} 409 'Custom child containing a nested recognized game is rejected'
    Expect-Library 'game-library' @{path=(Join-Path $xbox 'Known One');enabled=$true} 409 'A recognized game cannot be subdivided into a custom library'
    $unmarked=Post-Library 'game-library' @{path=$manual;enabled=$false}
    Assert-Library ($unmarked.revision -eq 2 -and (Shape-Library $unmarked.overview) -ceq $baselineShape -and @($unmarked.overview.games | Where-Object source -eq 'Custom game library').Count -eq 0) 'Unmark restores every original category aggregate'
    $known=Post-Library 'game-library' @{path=$xbox;enabled=$true}
    Assert-Library (@($known.overview.games | Where-Object { $_.name -eq 'Known One' -and $_.source -eq 'Known game folder' -and $_.libraryPath -eq $xbox }).Count -eq 1) 'Mark preserves existing known-layout game identity'
    Assert-Library (@($known.overview.games | Where-Object { $_.name -eq 'Empty Known' -and $_.size -eq 0 }).Count -eq 1) 'Known-layout empty child appears while explicitly marked'
    $knownOff=Post-Library 'game-library' @{path=$xbox;enabled=$false}
    Assert-Library (@($knownOff.overview.games | Where-Object { $_.name -eq 'Known One' -and $_.source -eq 'Known game folder' -and $_.size -eq 307 }).Count -eq 1 -and (Shape-Library $knownOff.overview) -ceq $baselineShape) 'Unmark retains known-layout fallback rows and categories'
    $steam=Post-Library 'game-library' @{path=$common;enabled=$true}
    $steamRow=@($steam.overview.games | Where-Object name -eq 'Manifest Title')[0]
    Assert-Library ($steamRow.source -eq 'Steam manifest' -and $steamRow.steamAppId -ceq '12345' -and $steamRow.size -eq 610 -and $steamRow.libraryPath -eq $common) 'Exact-path Steam metadata and trusted app ID survive marking'
    Assert-Library (@($steam.overview.games | Where-Object { $_.name -eq 'Empty Steam' -and $_.size -eq 0 }).Count -eq 1) 'Empty known Steam-layout child appears while explicitly marked'
    $steamOff=Post-Library 'game-library' @{path=$common;enabled=$false}
    Assert-Library (@($steamOff.overview.games | Where-Object { $_.name -eq 'Manifest Title' -and $_.steamAppId -ceq '12345' }).Count -eq 1 -and (Shape-Library $steamOff.overview) -ceq $baselineShape) 'Unmark retains Steam title, ID, and original category totals'
    Expect-Library 'game-library' @{path=(Join-Path $manual 'loose.txt');enabled=$true} 400 'Files cannot be marked as libraries'
    Expect-Library 'game-library' @{path=$manual;enabled='true'} 400 'Enabled requires a JSON boolean'
    Expect-Library 'game-library' @{path=$appRoot;enabled=$true} 404 'Unscanned folders cannot be marked'
    try { Get-Library 'game-library' | Out-Null; throw 'Unexpected GET success.' } catch { Assert-Library ($_.Exception.Response.StatusCode.value__ -eq 405) 'GET cannot mark or unmark libraries' }
    try { Invoke-RestMethod -Uri "$baseUrl/api/game-library" -Method Post -Headers @{Origin='https://example.com'} -ContentType 'application/json' -Body (@{path=$manual;enabled=$true} | ConvertTo-Json) | Out-Null; throw 'Unexpected foreign-origin success.' } catch { Assert-Library ($_.Exception.Response.StatusCode.value__ -eq 403) 'Foreign-origin requests cannot update game libraries' }
    $beforeFailure=Get-Library 'overview'; $lock=[System.IO.File]::Open($settings,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None)
    try { Expect-Library 'game-library' @{path=$simple;enabled=$true} 400 'Settings save failure rejects the mark before inventory changes' } finally { $lock.Dispose() }
    $afterFailure=Get-Library 'overview'
    Assert-Library ($afterFailure.revision -eq $beforeFailure.revision -and (Shape-Library $afterFailure) -ceq $baselineShape -and @($afterFailure.gameLibraries).Count -eq 0) 'Failed persistence leaves categories, marks, and revision unchanged'
    Post-Library 'game-library' @{path=$manual;enabled=$true} | Out-Null
    $saved=Get-Content -LiteralPath $settings -Raw | ConvertFrom-Json
    Assert-Library ($saved.version -eq 1 -and $saved.paths.Count -eq 1 -and $saved.paths[0] -ceq $manual -and -not (Test-Path -LiteralPath (Join-Path $appRoot 'game-libraries-47842.json'))) 'Only isolated app-local requested-port settings are written'
    Stop-Library; Start-Library
    $restored=Scan-Library @($fixture)
    Assert-Library ($restored.gameLibraries[0] -ceq $manual -and (Category-Library $restored 'Games').size -eq $baseGames+415 -and @($restored.games | Where-Object libraryPath -eq $manual).Count -eq 3) 'Restart and rescan restore saved libraries and empty child rows'
    $partial=Scan-Library @((Join-Path $alpha 'assets'))
    Assert-Library ($partial.size -eq 101 -and $partial.games.Count -eq 1 -and $partial.games[0].name -eq 'Alpha' -and $partial.games[0].path -eq (Join-Path $alpha 'assets') -and $partial.games[0].installationPath -eq $alpha -and $partial.games[0].libraryPath -eq $manual -and (Category-Library $partial 'Games').size -eq 101) 'Partial custom-game scan resolves unscanned library and clickable selected root'
    $multi=Scan-Library @((Join-Path $alpha 'assets'),$beta,(Join-Path $manual 'Empty'))
    Assert-Library ($multi.games.Count -eq 3 -and ($multi.games | Measure-Object size -Sum).Sum -eq 312 -and (Category-Library $multi 'Games').size -eq 312) 'Several partial roots remain disjoint including an empty game root'
    $export=Get-Library 'export'
    Assert-Library ($export.gameLibraries[0] -ceq $manual -and ($export.games | Measure-Object size -Sum).Sum -eq 312) 'Export includes saved library metadata and exact game sizes'
    $simpleScan=Scan-Library @($simple)
    $rootMarked=Post-Library 'game-library' @{path=$simple;enabled=$true}
    Assert-Library ($rootMarked.enabled -and @($rootMarked.overview.games | Where-Object libraryPath -eq $simple).Count -eq 2 -and (Category-Library $rootMarked.overview 'Games').size -eq 53) 'A selected scan root may be marked as a game library'
    Post-Library 'game-library' @{path=$simple;enabled=$false} | Out-Null
    Stop-Library
    $helperOutput=& $helperExe $candidate $fixture (Join-Path $testRoot 'reflection')
    if ($LASTEXITCODE -ne 0) { throw "Reflection helper failed: $helperOutput" }
    $helperReport=$helperOutput | ConvertFrom-Json
    foreach ($description in $helperReport.checks) { $checks.Add($description) }
    Assert-Library ($helperReport.nativeFileActions -eq 0) 'Inventory rename/recycle persistence simulations invoke no native file actions'
    $afterFiles=@(Get-ChildItem -LiteralPath $fixture -File -Recurse)
    Assert-Library ($afterFiles.Count -eq $baselineFiles.Count -and ($afterFiles | Measure-Object Length -Sum).Sum -eq $expectedBytes -and @(Compare-Object @($baselineFiles.FullName | Sort-Object) @($afterFiles.FullName | Sort-Object)).Count -eq 0) 'All owned inventory files and paths remain physically unchanged'
    $report=[ordered]@{passed=$checks.Count;failed=0;port=47842;fixture=$testRoot;fixtureRetained=$true;nativeFileActions=0;steamLaunched=$false;mainServiceTouched=$false;candidate=$candidate;sha256=(Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash;checks=@($checks)}
    $report | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'game-libraries-report.json') -Encoding UTF8
    $report | ConvertTo-Json -Depth 2
} finally { Stop-Library }
# Retain owned fixtures. Do not issue cleanup deletion or recycling requests.

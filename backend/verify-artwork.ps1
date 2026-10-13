param()
$ErrorActionPreference='Stop'
$appRoot=Split-Path $PSScriptRoot -Parent
$source=Join-Path $PSScriptRoot 'StorageAtlas.cs'
$icon=Join-Path $appRoot 'ui\file-gazer.ico'
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$candidate=Join-Path $PSScriptRoot 'candidate\FileGazer.exe'
$fixture=Join-Path $PSScriptRoot ('artwork-tests\fixture-'+[guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory((Split-Path $candidate -Parent)) | Out-Null
[System.IO.Directory]::CreateDirectory($fixture) | Out-Null
$argsCommon=@('/nologo','/optimize+','/platform:anycpu','/r:System.Web.Extensions.dll','/r:System.Windows.Forms.dll','/r:System.Drawing.dll',"/win32icon:$icon","/resource:$icon,FileGazer.Icon")
& $compiler @argsCommon /target:winexe "/out:$candidate" $source
if ($LASTEXITCODE -ne 0) { throw 'Production artwork candidate compilation failed.' }
$helper=Join-Path $fixture 'ArtworkChecks.exe'
& $compiler @argsCommon /target:exe /main:ArtworkChecks '/define:FILEGAZER_ARTWORK_TEST,FILEGAZER_SHELL_TEST' "/out:$helper" $source (Join-Path $PSScriptRoot 'verify-artwork.cs')
if ($LASTEXITCODE -ne 0) { throw 'Isolated artwork verifier compilation failed.' }
# This console verifier never calls the app entry point or starts a service/browser.
# Test-only compiler symbols block remote artwork downloads and native Shell invocation.
$output=& $helper $fixture
if ($LASTEXITCODE -ne 0) { throw "Artwork verifier failed: $output" }
$result=$output | ConvertFrom-Json
$report=[ordered]@{passed=$result.checks.Count;failed=0;fixture=$fixture;fixtureRetained=$true;personalScan=$false;appStarted=$false;nativeShellLaunched=$false;remoteImagesDownloaded=$false;candidate=$candidate;sha256=(Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash;checks=@($result.checks)}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'artwork-report.json') -Encoding UTF8
$report | ConvertTo-Json -Depth 3
# Keep generated fixtures ignored. Do not attempt cleanup deletion or recycling.

$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'StorageAtlas.cs'
$output = Join-Path (Split-Path $PSScriptRoot -Parent) 'FileGazer.exe'
$icon = Join-Path (Split-Path $PSScriptRoot -Parent) 'ui\file-gazer.ico'
if (-not (Test-Path -LiteralPath $icon)) { throw 'The File Gazer star icon is missing.' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
& $compiler /nologo /target:winexe /optimize+ /platform:anycpu /reference:System.Web.Extensions.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/win32icon:$icon" "/resource:$icon,FileGazer.Icon" "/out:$output" $source
if ($LASTEXITCODE -ne 0) { throw 'File Gazer compilation failed.' }
Write-Output $output

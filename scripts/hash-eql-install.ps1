<#
Read-only SHA-256 hashing of an EQL install (Windows-native variant). Resumable: skips paths already present in the output.
Usage: .\hash-eql-install.ps1 -InstallDir "..." -OutFile "$env:USERPROFILE\eqlcc-audit\hashes.tsv" [-MaxMB 512]
#>
param(
  [Parameter(Mandatory)][string]$InstallDir,
  [Parameter(Mandatory)][string]$OutFile,
  [int]$MaxMB = 512
)
if ($OutFile.StartsWith($InstallDir)) { throw "Refusing to write inside the game directory." }
New-Item -ItemType Directory -Force -Path (Split-Path $OutFile) | Out-Null
$done = @{}
if (Test-Path $OutFile) { Get-Content $OutFile | ForEach-Object { $done[($_ -split "`t")[1]] = $true } }
Get-ChildItem -LiteralPath $InstallDir -Recurse -File -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Length -le ($MaxMB * 1MB) -and -not $done[$_.FullName] } |
  ForEach-Object {
    $h = Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256 -ErrorAction SilentlyContinue
    if ($h) { "{0}`t{1}" -f $h.Hash, $_.FullName | Add-Content -Encoding UTF8 $OutFile }
  }
Write-Host "Hashes appended to: $OutFile"

<#
Read-only inventory of an EverQuest Legends installation (Windows-native variant).
Writes TSV manifest OUTSIDE the game directory. Never modifies the install.
Usage: .\inventory-eql-files.ps1 -InstallDir "C:\Users\Public\Daybreak Game Company\Installed Games\EverQuest Legends" -OutFile "$env:USERPROFILE\eqlcc-audit\manifest.tsv"
#>
param(
  [Parameter(Mandatory)][string]$InstallDir,
  [Parameter(Mandatory)][string]$OutFile
)
if ($OutFile.StartsWith($InstallDir)) { throw "Refusing to write inside the game directory." }
New-Item -ItemType Directory -Force -Path (Split-Path $OutFile) | Out-Null
Get-ChildItem -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
  $type = if ($_.PSIsContainer) { 'd' } else { 'f' }
  $size = if ($_.PSIsContainer) { 0 } else { $_.Length }
  "{0}`t{1}`t{2:yyyy-MM-dd HH:mm:ss}`t{3:yyyy-MM-dd HH:mm:ss}`t{4}`t{5}" -f $type, $size, $_.LastWriteTime, $_.CreationTime, $_.Attributes, $_.FullName
} | Set-Content -Encoding UTF8 $OutFile
Write-Host "Manifest written: $OutFile"

# Forge by Sona: adds right-click verbs to Explorer (per-user, no admin needed).
# Disc images -> Mount / Open / Extract ; Archives -> Open / Extract ; Media -> Open.
# Requires the app window: run `npm install` in apps/forge first.
# Uninstall: run with -Remove.
param([switch]$Remove)

$app  = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$exe  = Join-Path $app 'node_modules\electron\dist\electron.exe'
$icon = "$exe,0"

$disc    = '.iso', '.img', '.bin', '.nrg', '.mdf'
$archive = '.zip', '.7z', '.rar', '.tar', '.gz', '.tgz'
$media   = '.mp4', '.mov', '.mkv', '.webm', '.avi', '.gif', '.mp3', '.wav', '.flac', '.m4a', '.png', '.jpg', '.jpeg', '.webp'
$keys    = 'SonaForge.Mount', 'SonaForge.Open', 'SonaForge.Extract'

function Add-Verb($ext, $key, $label, $verb) {
  $base = "HKCU:\Software\Classes\SystemFileAssociations\$ext\shell\$key"
  New-Item -Force -Path $base | Out-Null
  New-Item -Force -Path "$base\command" | Out-Null
  Set-ItemProperty -Path $base -Name '(default)' -Value $label
  Set-ItemProperty -Path $base -Name 'Icon' -Value $icon
  $cmd = '"' + $exe + '" "' + $app + '" --forge-verb=' + $verb + ' "%1"'
  Set-ItemProperty -Path "$base\command" -Name '(default)' -Value $cmd
}
function Remove-Verbs($ext) {
  foreach ($k in $keys) {
    $p = "HKCU:\Software\Classes\SystemFileAssociations\$ext\shell\$k"
    if (Test-Path $p) { Remove-Item -Recurse -Force $p }
  }
}

$all = $disc + $archive + $media | Select-Object -Unique
if ($Remove) {
  foreach ($e in $all) { Remove-Verbs $e }
  Write-Host "Forge shell verbs removed."
  return
}

if (-not (Test-Path $exe)) { throw "Electron not found at $exe. Run 'npm install' in the forge folder first." }

foreach ($e in $disc)    { Add-Verb $e 'SonaForge.Mount' 'Mount with Forge' 'mount'; Add-Verb $e 'SonaForge.Open' 'Open with Forge' 'open'; Add-Verb $e 'SonaForge.Extract' 'Extract with Forge' 'extract' }
foreach ($e in $archive) { Add-Verb $e 'SonaForge.Open' 'Open with Forge' 'open'; Add-Verb $e 'SonaForge.Extract' 'Extract with Forge' 'extract' }
foreach ($e in $media)   { Add-Verb $e 'SonaForge.Open' 'Open with Forge' 'open' }

Write-Host "Forge shell verbs installed for: $($all -join ', ')"

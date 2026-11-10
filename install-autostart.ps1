# Crea un acceso directo en la carpeta Inicio para arrancar el notch con Windows.
# Uso:  powershell -ExecutionPolicy Bypass -File install-autostart.ps1   (añade -Remove para quitarlo)
param([switch]$Remove)
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Akita Notch.lnk'
if ($Remove) { Remove-Item $lnk -ErrorAction SilentlyContinue; "Autoarranque quitado."; return }
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$s.TargetPath = Join-Path $PSScriptRoot 'node_modules\electron\dist\electron.exe'
$s.Arguments = '"' + $PSScriptRoot + '"'
$s.WorkingDirectory = $PSScriptRoot
$s.Save()
"Autoarranque creado: $lnk"

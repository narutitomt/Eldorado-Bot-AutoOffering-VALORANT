$url  = "https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi"
$dest = "$env:TEMP\node-setup.msi"
Write-Host "Descargando Node.js (~30MB)..."
Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
Write-Host "Instalando Node.js..."
Start-Process msiexec -ArgumentList "/i `"$dest`" /quiet /norestart" -Wait
Remove-Item $dest -Force -ErrorAction SilentlyContinue
Write-Host "Node.js instalado."

# Run in PowerShell AS ADMINISTRATOR to allow inbound TCP 8787 (Fuel API).
# Right-click PowerShell -> Run as administrator, then:
#   cd path\to\Fuel\server\scripts
#   .\open-firewall-8787.ps1

$ruleName = "Fuel API 8787 TCP"
$existing = netsh advfirewall firewall show rule name=$ruleName 2>$null
if ($LASTEXITCODE -eq 0) {
  Write-Host "Rule already exists: $ruleName"
  exit 0
}

netsh advfirewall firewall add rule name=$ruleName dir=in action=allow protocol=TCP localport=8787
if ($LASTEXITCODE -ne 0) {
  Write-Host "Failed. Run this script as Administrator."
  exit 1
}
Write-Host "Opened Windows Firewall for TCP port 8787 (inbound)."
Write-Host "Start the API: cd server && npm start"

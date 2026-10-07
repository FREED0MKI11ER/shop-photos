param(
  [string]$Port = "3000",
  [string]$RuleName = "ShopMediaShare"
)

# Adds a Windows Firewall rule so phones on the Wi-Fi can reach the site.
# Run in an elevated (Administrator) PowerShell window.

if (Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue) {
  Write-Host "Firewall rule '$RuleName' already exists."
} else {
  New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $Port -Profile Any | Out-Null
  Write-Host "Firewall rule '$RuleName' added for TCP port $Port."
}

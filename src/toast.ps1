param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Body,
  [string]$Url = '',
  [string]$LocalUrl = ''
)

$ErrorActionPreference = 'Stop'

$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]

$escapedTitle = [System.Security.SecurityElement]::Escape($Title)
$escapedBody = [System.Security.SecurityElement]::Escape($Body)
$launch = ''
if ($Url) {
  $escapedUrl = [System.Security.SecurityElement]::Escape($Url)
  $launch = " activationType=`"protocol`" launch=`"$escapedUrl`""
}

$actions = ''
if ($LocalUrl) {
  $escapedLocalUrl = [System.Security.SecurityElement]::Escape($LocalUrl)
  $actions = "<actions><action content=`"Local matches`" activationType=`"protocol`" arguments=`"$escapedLocalUrl`"/></actions>"
}

$xml = @"
<toast$launch>
  <visual>
    <binding template="ToastGeneric">
      <text>$escapedTitle</text>
      <text>$escapedBody</text>
    </binding>
  </visual>
  $actions
</toast>
"@

$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
$toast = New-Object Windows.UI.Notifications.ToastNotification($doc)

# PowerShell's registered AppUserModelID — toasts from an unregistered id are dropped.
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)

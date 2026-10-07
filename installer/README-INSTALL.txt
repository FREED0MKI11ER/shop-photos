SHOP PHOTOS - INSTALL INSTRUCTIONS
==================================

This kit turns a Windows PC into the shop's photo/video server. Phones and
other computers on the same Wi-Fi can then upload and download photos.

WHAT YOU NEED
-------------
- A Windows PC that stays powered on (this becomes the server).
- The PC connected to the shop Wi-Fi.
- Administrator rights on that PC (for the first install only).
- No internet is needed on that PC; Node.js is included in this kit.


INSTALL
-------
1. Copy this whole folder to the shop PC (USB stick or network share).
2. Right-click "install.bat" and choose "Run as administrator".
3. Approve the Windows prompt. Wait for it to finish.
4. It prints an address like http://192.168.1.50:3000 - that is your site.

That's it. The site now starts automatically every time the PC boots.


GET PHONES CONNECTED
--------------------
1. On a phone, connect to the same Wi-Fi.
2. Open the address shown by the installer in the phone's browser.
   Tip: open the site on the server PC, go to the "Connect" tab, and scan
   the QR code with the phone.
3. Enter an employee ID (saved on that phone after the first time).
4. Upload photos/videos, or browse and download them.

To add it to the home screen:
- iPhone (Safari): Share -> Add to Home Screen.
- Android (Chrome): menu (three dots) -> Add to Home screen.


OPTIONS
-------
The installer accepts optional settings (advanced). Open an elevated
PowerShell in this folder and run, for example:

  powershell -ExecutionPolicy Bypass -File install.ps1 -Port 8080
  powershell -ExecutionPolicy Bypass -File install.ps1 -InstallDir "D:\ShopPhotos"

  -InstallDir   Where to install (default: C:\Program Files\ShopPhotos)
  -Port         Web port (default: 3000)
  -ServiceName  Windows service name (default: ShopMediaShare)


KEEPING THE ADDRESS STABLE
--------------------------
The address is based on the PC's network address. To keep it from changing,
ask whoever manages the router to reserve a fixed address (DHCP reservation)
for this PC, or set a static IP on the PC.


UNINSTALL
---------
Right-click "uninstall.bat" and choose "Run as administrator".
Your uploaded photos are kept in <InstallDir>\data unless you pass -RemoveData.


IMPORTANT
---------
The employee ID is only a label - it is NOT a password. Anyone on the Wi-Fi
can enter any ID. Do not store anything sensitive on this site.

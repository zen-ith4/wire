Secure Connection to Wire — Guide

This guide depends on how the server is configured. The setup page will tell you which mode your server is using.

Mode 1: The server has a domain (automatic HTTPS with Let's Encrypt)

You don't need to do anything. Just open the address:

https://chat.example.com

Your browser or desktop app will connect without any warnings — exactly like any other website.

Mode 2: The server only uses WireGuard (no domain)

First, make sure you're connected to WireGuard, just like you normally would. Then you have two options, depending on whether you're using a browser or the Electron desktop app.

If you're using a browser (Chrome/Firefox/Safari)

Open the address using https:// (not http://):

https://10.10.0.7

You'll see a warning such as "Your connection is not private" or something similar.

This is expected because the certificate wasn't issued by a publicly trusted CA — not because the connection is actually unsafe.

Click Advanced, then Proceed to 10.10.0.7 (unsafe) (or the equivalent option in your browser).

That's it.

After doing this once, everything will work normally — including E2EE and voice features, because the connection is genuinely using HTTPS. The browser is simply warning you that it doesn't recognize the certificate as being issued by a trusted CA.

Why do I need to use https://?

Because browser features such as end-to-end encryption and voice communication require a secure context (HTTPS). This is a browser security requirement, not a limitation imposed by Wire.

If you're using the Electron desktop app

The desktop app behaves differently. Instead of showing a clickable browser warning page, it displays a confirmation window containing the server's certificate fingerprint:

Fingerprint (SHA-256):

40:D3:F4:D0:A8:60:02:39:7E:D2:07:C6:A4:A3:84:DE:...

Before clicking "Trust This Certificate," verify this fingerprint with the server administrator. It should match the fingerprint displayed during the server setup wizard.

If the fingerprints match, you can safely trust the certificate.

After you confirm it, the app remembers the fingerprint. You won't be asked again unless the server's fingerprint changes.

If the fingerprint changes, the app shows a more serious warning because the server may have been reinstalled, or someone could potentially be interfering with the connection — similar to SSH showing:

REMOTE HOST IDENTIFICATION HAS CHANGED

What you don't need to do: You don't need to manually install any certificate, change system settings, or import any files. The one-time confirmation in the app is all that's required.

If the fingerprint changes and you don't know why

Don't connect.

Contact the server administrator through a separate channel — not through the Wire app itself — such as another messaging app or a phone call.

If the server was genuinely reinstalled (for example, the OS was replaced), get the new fingerprint from the administrator and compare it.

If the administrator doesn't know why the fingerprint changed, don't connect and notify them about it.
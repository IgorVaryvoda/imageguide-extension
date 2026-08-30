# ImageGuide Image Auditor privacy policy

Last updated: 30 August 2026

ImageGuide Image Auditor processes audit data in its popup and full-audit tab. It does not
automatically transmit the page URL, audit report, image list, or image URLs to
ImageGuide.

## Network requests

- If the user selects **Check response sizes**, the extension requests temporary host
  permission for the relevant image origins. One click checks at most 100 resources. It
  makes up to six credential-free `HEAD` requests at once and,
  when needed, credential-free range requests. It accepts only validated image responses,
  cancels response bodies, and removes permissions granted for that check. Permissions the
  user had granted before the check are preserved. These checks send no cookies or
  extension-generated identifiers. As with any network connection, the image server still
  receives ordinary network metadata such as an IP address.
- User-clicked links open pages on `imageguide.dev`. The converter link does not contain the
  audited image URL or an audit report. Like any website visit, ImageGuide receives ordinary
  network metadata such as the visitor's IP address and any cookies already associated with
  that site. The extension adds no identifier.

## Local storage

The extension stores the user's last finding filter and sort choice in Chrome local
extension storage. Audit results stay in extension memory and disappear when their popup or
full-audit tab closes. Audit results are not written to extension storage.

## Accounts, analytics, sale, and sharing

The extension has no account system and no analytics. ImageGuide does not collect, sell, or
share audit reports through the extension.

Questions can be sent through https://www.imageguide.dev/contact.

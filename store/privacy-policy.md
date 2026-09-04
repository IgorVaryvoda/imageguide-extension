# ImageGuide Image Auditor privacy policy

Last updated: 4 September 2026

ImageGuide Image Auditor processes audit data in its popup and full-audit tab. It does not
automatically transmit the page URL, audit report, image list, or image URLs to
ImageGuide.

## Network requests

- If the user selects **Check response sizes**, the extension requests temporary host
  permission for the relevant image origins. One click checks at most 100 resources. It
  makes up to six credential-free `HEAD` requests at once and,
  when needed, credential-free range requests. It accepts only validated image responses,
  cancels response bodies, and removes permissions granted for that check. Permissions the
  user had granted before the check are preserved. Failed checks record an attempt
  outcome without resetting progress, cancelling keeps completed measurements, and
  retrying always needs another explicit click. These checks send no cookies or
  extension-generated identifiers. As with any network connection, the image server still
  receives ordinary network metadata such as an IP address.
- User-clicked links open pages on `imageguide.dev`. The converter link does not contain the
  audited image URL or an audit report. Like any website visit, ImageGuide receives ordinary
  network metadata such as the visitor's IP address and any cookies already associated with
  that site. The extension adds no identifier.

## Local storage

The extension stores the user's last finding filter and sort choice in Chrome local
extension storage. Audit results otherwise stay in extension memory and disappear when
their popup or full-audit tab closes. Opening the full audit from the popup carries
completed validated measurements through a one-use handoff in Chrome session storage:
a random token, a 60-second expiry, and an aggregate serialized cap at the existing
4 MB page payload budget. The handoff is consumed and deleted when the audit opens,
expired items are purged on access, and any storage failure falls back to a fresh scan
with an explanation. No audited URL or report is ever placed in a navigation query
string, and no report history is retained.

## Accounts, analytics, sale, and sharing

The extension has no account system and no analytics. ImageGuide does not collect, sell, or
share audit reports through the extension.

Questions can be sent through https://www.imageguide.dev/contact.

---
"sandburg": patch
---

The host server answers only requests that carry a browser's `Sec-Fetch-Site` (`same-origin`, or `none` for a navigation the user starts); a request without the header, or with a value no browser sends, gets a 403 before any route sees it. Chromium sends the header with every request to a sandbox origin. The file channel's WebSocket upgrade, whose handshake carries no `Sec-Fetch-Site`, keeps its `Origin` check. Code comments now record that sandbox ids are not secrets: nothing is granted for knowing one.

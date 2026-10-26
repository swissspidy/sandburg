---
"sandburg": patch
---

Besides cross-site requests, the host server now refuses requests not shaped as a browser's. It answers only requests that carry a browser's `Sec-Fetch-Site` (`same-origin`, or `none`, which only the browser itself sends (user-initiated navigations)); a request without the header, or with a value no browser sends, gets a 403 before any route sees it. Chromium sends the header with every request to a sandbox origin, and a page's script cannot set it; a raw HTTP client can send any value, so the header is not authentication. The file channel's WebSocket upgrade, whose handshake carries no `Sec-Fetch-Site`, keeps its `Origin` check. Code comments now record that sandbox ids are not secrets: nothing is granted for knowing one.

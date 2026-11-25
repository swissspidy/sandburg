---
"sandburg": patch
---

An app that refuses to be framed renders. The app runs in the host page's frame, so an `X-Frame-Options` header (`DENY`) or a Content-Security-Policy with `frame-ancestors 'none'` (Helmet's defaults) made the browser show its error page instead of the app, which then failed the ready phase. Its responses now reach the frame with `frame-ancestors 'self'` in place of its own in each Content-Security-Policy (report-only too), the policy's other directives kept, and with `X-Frame-Options` replaced by a policy of `frame-ancestors 'self'`: the host page can frame the app, other pages (another run's) still cannot. An error page that refuses to be framed (Nuxt's 500) is now shown in the frame too, as it is outside Sandburg.

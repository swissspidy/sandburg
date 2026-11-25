---
"sandburg": patch
---

A page that loads its stylesheets, scripts, images or fonts from an absolute `http://localhost:<port>/…` URL gets them. A server sees `Host: localhost:<port>`, as on the developer's machine, so an app that builds its asset URLs from it (Express' `` `http://${req.get('host')}/style.css` ``) wrote that origin into its markup; the page runs on another origin, and those requests went to the network and failed. They are now served by the app's server on that port, as `fetch()` and `XMLHttpRequest` calls to such URLs already were. A request from the app's own code to a localhost port where nothing listens now fails with `ECONNREFUSED`, as in Node, instead of getting an HTTP error response.

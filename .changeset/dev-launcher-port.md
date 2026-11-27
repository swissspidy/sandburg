---
'sandburg': patch
---

A dev script that is one command starting several servers (`"dev": "node dev.mjs"`, which starts an API and then `ng serve`) shows the page's server, not the API that listened first: while another of the program's processes is still starting, the app's port is the one that answers with a page. A single server still is the app as soon as it listens, whatever it answers.

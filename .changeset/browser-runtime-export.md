---
"sandburg": minor
---

The browser runtime ships prebuilt as `sandburg/browser-runtime`: a page of your own can serve its directory as static files and run a project in the visitor's browser (dev server and app, packages installed from the npm registry in the page), without the CLI, a Node.js process or Playwright. See the "Embedding the browser runtime" guide.

**Breaking:** Playwright (`playwright-core` and `@playwright/test`) is now an optional peer dependency, so that embedders do not download it. The CLI and the library need it installed beside Sandburg: `npm install --save-dev @playwright/test@1.65.1 playwright-core@1.65.1`. Without it, `sandburg` exits with code 2 and prints that command.

/**
 * Splits src/page-checks/runtime.ts (the checks' runtime in the page) into its locators, its
 * assertions and the rest, by moving declarations as they are (scripts/split-module.ts), as
 * scripts/split-worker.ts does for the Node runtime. Run it on a tree where runtime.ts has not been
 * split, then `npm run typecheck && npm run lint`:
 *
 *   node scripts/split-page-checks.ts
 */
import { splitModule } from './split-module.ts';

const RUNTIME = 'src/page-checks/runtime.ts';

splitModule(
  RUNTIME,
  'src/page-checks/locator.ts',
  ['Text', 'FilterOptions', 'textBody', 'filterSelector', 'ActionNeeds', 'editable', 'normalize', 'Locatable', 'Locator', 'safeElements', 'SET_VALUE_TYPES', 'setNativeValue', 'modifier', 'escapeKeys', 'keySequence'],
  "The page checks' locators: Playwright's Locator API over the app frame's DOM (ivya's selectors),\nand the actions on what they find.",
);

splitModule(
  RUNTIME,
  'src/page-checks/expect.ts',
  ['Outcome', 'Matcher', 'show', 'failure', 'deepEqual', 'textMatches', 'locatorMatchers', 'appMatchers', 'ValueMatcher', 'valueMatchers', 'bind', 'makeExpect'],
  "The page checks' expect: Playwright's web-first assertions on locators and the page, which retry\nuntil they pass or time out, and its value assertions.",
);

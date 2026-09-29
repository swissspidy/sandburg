import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const SANDBURG_VERSION: string = (require('../package.json') as { version: string }).version;

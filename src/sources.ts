import { fileURLToPath } from 'node:url';

/**
 * A file of src/, by its path there. The host page, the runtime's workers and the service
 * worker are bundled or served from src/, also when Sandburg itself runs from dist/ (as
 * installed from npm), so this resolves the same from both.
 */
export const source = (path: string): string => fileURLToPath(new URL(`../src/${path}`, import.meta.url));

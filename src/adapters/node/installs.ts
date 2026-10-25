/**
 * The installer every run of the node runtime shares, and the directory of the caches kept beside
 * its installs.
 */
import { join } from 'node:path';
import { sharedInstaller } from './install.ts';

export const installer = sharedInstaller();

export const devCacheRoot = () => join(installer.root, '..', 'dev-cache');

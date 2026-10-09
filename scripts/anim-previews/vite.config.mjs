import { fileURLToPath } from 'node:url';
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
export default {
  resolve: { alias: { three: `${REPO_ROOT}/packages/canvas/node_modules/three` } },
  build: { target: 'chrome120' },
  logLevel: 'warn',
};

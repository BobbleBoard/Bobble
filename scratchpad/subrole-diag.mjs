import { call, done } from './mac-drive.mjs';
const w = await call('windows', { app: 'TextEdit' });
console.log(JSON.stringify((w.windows ?? []).map((x) => [x.role, x.subrole, x.title, x.modal, x.sheet, x.frame.w + 'x' + x.frame.h]), null, 0));
console.log('active:', JSON.stringify(w.active));
done(); process.exit(0);

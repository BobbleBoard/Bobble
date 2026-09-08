import { call, done, sleep } from './mac-drive.mjs';
const pid = (await call('windows', { app: 'TextEdit' })).pid;
for (let i = 0; i < 6; i += 1) {
  const w = await call('windows', { pid });
  const s = await call('snapshot', { pid });
  console.log(i, 'windows=', (w.windows ?? []).length, JSON.stringify((w.windows ?? []).map((x) => [x.role, x.title])).slice(0, 160), '| snapshot.windows=', (s.windows ?? []).length, '| elements=', (s.elements ?? []).length);
  await sleep(400);
}
done();
process.exit(0);

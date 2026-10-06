import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const example = await readFile(
  new URL('../.env.example', import.meta.url),
  'utf8',
);
const env = example
  .replace(/^API_KEY=.*$/m, `API_KEY=${randomBytes(32).toString('hex')}`)
  .replace(/^ADMIN_KEY=.*$/m, `ADMIN_KEY=${randomBytes(32).toString('hex')}`);
try {
  await writeFile(new URL('../.env', import.meta.url), env, {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(
    'Created .env with separate random API and admin keys. Keep this file private.',
  );
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('.env already exists; left it unchanged.');
}

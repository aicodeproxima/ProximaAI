// Prints a bcrypt hash (cost 12, $2a$, verified compatible with pgcrypto crypt()) of the value in env BK.
// Never prints, logs or stores the value. Used 2026-10-20 to set the backup code: only the hash went to the database.
//
//   npm i --prefix <scratch>/bcrypt-pkg bcryptjs@2.4.3 --ignore-scripts
//   BCRYPTJS=<scratch>/bcrypt-pkg/node_modules/bcryptjs BK='<value>' node scripts/tools/bcrypt-hash.mjs
//
// Then store it where the server reads it (review #4). From P1's M1 (20261023100000), when proxima_auth.users exists:
//   update proxima_auth.users set backup_code_hash = '<hash>', backup_failed = 0, backup_locked_until = null,
//          updated_at = now() where role = 'owner';
// (M1 freezes the app_secrets row: a hash written there is never read, and an M1 rollback overwrites it with the
// owner row's code.) Only before M1, or after its rollback (the table is absent): insert into app_secrets
//   (key, value, updated_at) values ('admin_backup_code_hash', jsonb_build_object('hash', '<hash>'), now())
//   on conflict (key) do update ...
// Prove pgcrypto compatibility with a DUMMY value first (crypt('dummy', '<dummy hash>') = '<dummy hash>').
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const bcrypt = require(process.env.BCRYPTJS || 'bcryptjs');
const value = process.env.BK;
if (!value) { console.error('BK not set'); process.exit(2); }
const hash = bcrypt.hashSync(value.trim(), 12); // the server trims codes before comparing
if (!hash.startsWith('$2a$12$') || !bcrypt.compareSync(value.trim(), hash) || bcrypt.compareSync(value.trim() + 'x', hash)) {
  console.error('self-check failed'); process.exit(1);
}
console.log(hash);

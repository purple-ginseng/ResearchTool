// Workspace backups (lib/backup.js; UI: the Backup part of Settings and the Backups window, public/js/safety.js)
//   GET  /api/backup                 {dir, auto, isDefault, defaultDir, running, snapshots[{name, when, reason, files, bytes,
//                                     copied, papers, other}], last, stale, days, size, error}
//   POST /api/backup                 take a snapshot now -> {snapshot, ...status}
//   POST /api/backup/restore {name}  put a snapshot back (the current state is kept as a snapshot and in the trash)
// The folder and the daily switch are saved with PUT /api/settings {backupDir, backupAuto}.
const backup = require('../backup');

backup.schedule(); // the daily backup

async function handle(ctx) {
  const { path: p, method: M, send } = ctx;
  if (p === '/api/backup' && M === 'GET') return send(200, backup.status({ sizes: ctx.query.get('sizes') !== '0' }));
  if (p === '/api/backup' && M === 'POST') { const snapshot = await backup.run('manual'); return send(200, { snapshot, ...backup.status() }); }
  if (p === '/api/backup/restore' && M === 'POST') return send(200, await backup.restore((await ctx.json()).name));
  return false;
}

module.exports = { handle };

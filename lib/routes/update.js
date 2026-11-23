// Updates of the app itself (lib/update.js; UI: Preferences › General › Updates and the restart notice, public/js/update.js)
//   GET  /api/update/status           what is known, without any network request, without starting a program and
//                                     without changing anything
//                                     (?local=1 also looks at the local git conditions: a few read-only git commands,
//                                     one look at a time, reused for a few seconds - a GET is not covered by X-RT)
//   POST /api/update/check {apply?}   one git fetch of the official repository's main branch and the comparison;
//                                     {apply: true} also fast-forwards when every condition holds
// Both answer { auto, disabled, supported, reason, detail?, version, commit, running: {version, commit}, restartNeeded,
//   checking, ahead, behind, available: {commit, version} | null, lastCheck: {when, result, reason} | null,
//   updated: {from, to, version, restartNeeded: true} | null }; the POST adds result ('up-to-date' | 'available' |
//   'updated' | 'failed' | 'busy') and throttled (asked again within a minute: no second request was made).
// `reason` is a code (not-git, origin, config, dirty, interrupted, offline ...): the page holds the sentences, so they are translated, and
// no git output or path ever reaches the browser. Nothing of the request body but `apply` is read, and nothing of
// it reaches git. The switch itself is saved with PUT /api/settings {autoUpdate}.
const core = require('../core');
const update = require('../update');

const makeHandle = (updater) => async function handle(ctx) {
  const { path: p, method: M, send } = ctx;
  if (p === '/api/update/status' && M === 'GET') return send(200, await updater.status({ local: ctx.query.get('local') === '1' }));
  if (p === '/api/update/check' && M === 'POST') {
    const b = await ctx.json();
    if ('apply' in b && typeof b.apply !== 'boolean') throw core.httpErr(400, 'apply must be true or false');
    return send(200, await updater.check({ apply: b.apply === true }));
  }
  return false;
};

const updater = update.real();
updater.schedule(); // the daily check - which does nothing at all unless the box is ticked

module.exports = { handle: makeHandle(updater), makeHandle, updater };

/* Headless sanity check for the rotation engine. Run: node tools/verify-schedule.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const sandbox = {
    console, Date, Math, JSON, TextEncoder,
    setTimeout, clearTimeout, setInterval,
    document: { addEventListener() { } },
    localStorage: { getItem: () => null, setItem() { }, removeItem() { } },
    sessionStorage: { getItem: () => null, setItem() { }, removeItem() { } }
};
sandbox.window = sandbox;
sandbox.global = sandbox;
vm.createContext(sandbox);

['js/config.js', 'js/util.js', 'js/schedule.js'].forEach(f => {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
});

const { App, APP_CONFIG } = sandbox;
const S = App.schedule, U = App.util;

let failures = 0;
function check(name, cond, extra) {
    if (cond) console.log('  ok   ' + name);
    else { failures++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
}

const ROSTER = ['Shahrin Noor Sarah', 'Mushfiqur Rahman Pranto', 'Ahanaf Fahad Sinan', 'Sirajum Munira', 'Taki Al Zaki', 'Tashkir'];
const ctx = { roster: ROSTER, states: {}, rotationOffset: 0, now: new Date(2026, 6, 25) };

console.log('\n── anchor ──');
console.log('  configured start :', APP_CONFIG.schedule.startDate);
console.log('  first real slot  :', S.anchorDate.toDateString());
check('anchor is a publish day', S.isPublishDay(S.anchorDate));
check('anchor is on/after start', S.anchorDate >= U.parseISODate(APP_CONFIG.schedule.startDate));
check('anchor sequence is 0', S.sequenceOf(S.anchorDate) === 0, S.sequenceOf(S.anchorDate));

console.log('\n── first 18 slots ──');
const first = S.buildRange(S.anchorDate, U.addDays(S.anchorDate, 63), ctx);
first.slice(0, 18).forEach(s => {
    console.log('  #' + String(s.sequence).padStart(2) + '  ' + s.date.toDateString().padEnd(16) + '  ' + s.designer);
});

console.log('\n── continuity ──');
const seqs = first.map(s => s.sequence);
check('sequence increments by exactly 1', seqs.every((v, i) => i === 0 || v === seqs[i - 1] + 1), seqs.join(','));
check('only Fri/Sat', first.every(s => [5, 6].includes(s.date.getDay())));

console.log('\n── fairness over 12 months ──');
const year = S.buildRange(S.anchorDate, U.addDays(S.anchorDate, 364), ctx);
const counts = {};
year.forEach(s => counts[s.designer] = (counts[s.designer] || 0) + 1);
Object.entries(counts).forEach(([n, c]) => console.log('  ' + n.padEnd(26) + c));
const vals = Object.values(counts);
check('every designer appears', vals.length === ROSTER.length);
check('spread is at most 1 slot', Math.max(...vals) - Math.min(...vals) <= 1, vals.join(','));
check('no designer twice in a row', year.every((s, i) => i === 0 || s.designer !== year[i - 1].designer));

console.log('\n── month boundary (the v1 bug) ──');
const julEnd = S.buildMonth(2026, 6, ctx).slice(-1)[0];
const augStart = S.buildMonth(2026, 7, ctx)[0];
console.log('  last of July  :', julEnd.date.toDateString(), '→', julEnd.designer);
console.log('  first of Aug  :', augStart.date.toDateString(), '→', augStart.designer);
check('rotation does not reset each month', augStart.sequence === julEnd.sequence + 1);
const firstOfEachMonth = [];
for (let m = 6; m < 18; m++) {
    const list = S.buildMonth(2026 + Math.floor(m / 12), m % 12, ctx);
    if (list.length) firstOfEachMonth.push(list[0].designer);
}
check('first slot of each month is not always the same person',
    new Set(firstOfEachMonth).size > 1, firstOfEachMonth.join(', '));

console.log('\n── id format is v1-compatible ──');
const d = new Date(2026, 7, 1);
check('slot id "2026-7-1"', S.slotIdFor(d) === '2026-7-1', S.slotIdFor(d));

console.log('\n── three-tier resolution ──');
const id = S.slotIdFor(first[3].date);
const withOverride = S.build(first[3].date, Object.assign({}, ctx, {
    states: { [id]: { overrideDesigner: 'Sirajum Munira', committedDesigner: 'Tashkir' } }
}));
check('override beats committed', withOverride.designer === 'Sirajum Munira', withOverride.designer);
const withCommit = S.build(first[3].date, Object.assign({}, ctx, {
    states: { [id]: { committedDesigner: 'Tashkir' } }
}));
check('committed beats projection', withCommit.designer === 'Tashkir', withCommit.designer);
check('projection used when nothing stored', first[3].assignmentSource === 'projected');
check('orphan detected', S.build(first[3].date, Object.assign({}, ctx, {
    states: { [id]: { committedDesigner: 'Someone Gone' } }
})).orphanDesigner === true);

console.log('\n── deadlines & statuses ──');
const slot = first[0];
const cfg = APP_CONFIG.schedule;
check('reveal is ' + cfg.revealDays + 'd before', U.daysBetween(slot.revealAt, slot.date) === cfg.revealDays);
check('deadline hour is ' + cfg.deadlineHour, slot.deadlineAt.getHours() === cfg.deadlineHour);
check('grace is +' + cfg.graceHours + 'h', (slot.graceEndsAt - slot.deadlineAt) / 3600000 === cfg.graceHours);

function statusAt(now, state) {
    return S.build(slot.date, Object.assign({}, ctx, { now, states: { [slot.id]: state || {} } })).status.key;
}
const beforeReveal = U.addDays(slot.revealAt, -1);
const afterReveal = U.addDays(slot.revealAt, 1);
const dayBefore = new Date(slot.date.getTime() - 6 * 3600000);
const afterDeadline = new Date(slot.deadlineAt.getTime() + 3600000);
const afterGrace = new Date(slot.graceEndsAt.getTime() + 3600000);

check('locked before reveal', statusAt(beforeReveal) === 'locked', statusAt(beforeReveal));
check('open after reveal', statusAt(afterReveal) === 'open', statusAt(afterReveal));
check('due soon within 48h', statusAt(dayBefore) === 'due', statusAt(dayBefore));
check('overdue inside grace', statusAt(afterDeadline) === 'overdue', statusAt(afterDeadline));
check('missed after grace', statusAt(afterGrace) === 'missed', statusAt(afterGrace));
check('not missed if excused', statusAt(afterGrace, { excused: true }) === 'excused');
check('not missed if cancelled', statusAt(afterGrace, { cancelled: true }) === 'cancelled');
check('submitted shows in review',
    statusAt(afterGrace, { submitted: true, posterUrls: ['data:image/jpeg;base64,x'] }) === 'submitted');
check('approved wins over everything',
    statusAt(afterGrace, { approved: true, submitted: true }) === 'approved');
check('revision surfaces', statusAt(afterReveal, { needsRevision: true }) === 'revision');
check('submitted-but-empty asks for re-upload',
    statusAt(afterReveal, { submitted: true }) === 'open', statusAt(afterReveal, { submitted: true }));

console.log('\n── submission window ──');
check('cannot submit before reveal', S.canSubmit(slot, beforeReveal, false) === false);
check('can submit after reveal', S.canSubmit(slot, afterReveal, false) === true);
check('can submit inside grace', S.canSubmit(slot, afterDeadline, false) === true);
check('cannot submit after grace', S.canSubmit(slot, afterGrace, false) === false);
check('owner can backfill after grace', S.canSubmit(slot, afterGrace, true) === true);
check('late flag set past deadline', S.isLate(slot, afterDeadline) === true);
check('not late before deadline', S.isLate(slot, afterReveal) === false);

console.log('\n── roster stats ──');
const statsCtx = Object.assign({}, ctx, { now: U.addDays(S.anchorDate, 60) });
const stats = S.rosterStats(ROSTER, statsCtx, S.anchorDate, U.addDays(S.anchorDate, 120));
check('one row per designer', stats.length === ROSTER.length);
check('upcoming slots are never scored as missed',
    stats.every(r => r.reliability === null || r.reliability >= 0));
stats.forEach(r => console.log('  ' + r.name.padEnd(26) +
    'assigned ' + String(r.assigned).padStart(2) +
    '  resolved ' + String(r.resolved).padStart(2) +
    '  next ' + (r.nextSlot ? r.nextSlot.date.toDateString() : '—')));

console.log('\n── rotation offset ──');
const shifted = S.build(S.anchorDate, Object.assign({}, ctx, { rotationOffset: 1 }));
check('offset shifts by one person', shifted.designer === ROSTER[1], shifted.designer);
const negative = S.build(S.anchorDate, Object.assign({}, ctx, { rotationOffset: -1 }));
check('negative offset wraps correctly', negative.designer === ROSTER[ROSTER.length - 1], negative.designer);

console.log('\n── empty roster ──');
const none = S.build(S.anchorDate, { roster: [], states: {}, now: ctx.now });
check('no crash with empty roster', none.designer === null);

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'All checks passed.') + '\n');
process.exit(failures ? 1 : 0);

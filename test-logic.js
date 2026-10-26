// OPTIONAL check that the review-status and comparison logic works. Run:  node test-logic.js
// Every line should end with "OK".
const { deriveReviewStatus, compareInspections } = require('./tenancyLogic');
let failed = 0;
const check = (label, got, expected) => { const ok = got === expected; if (!ok) failed++; console.log((ok ? 'OK    ' : 'FAIL  ') + label + (ok ? '' : `  (got ${got}, expected ${expected})`)); };

const insp = { id: 'i1', version: 1, reviewDeadline: '2020-01-01T00:00:00Z' };
const yes = [{ inspectionId: 'i1', kind: 'confirm', reportVersion: 1 }];
check('Before deadline, no reply -> awaiting', deriveReviewStatus(insp, [], [], Date.parse('2019-12-01')), 'awaiting_tenant');
check('After deadline, no reply -> overdue (never "confirmed")', deriveReviewStatus(insp, [], [], Date.parse('2021-01-01')), 'overdue');
check('Tenant confirmed -> confirmed', deriveReviewStatus(insp, [], yes), 'confirmed');
check('Report updated after confirming -> must be confirmed again', deriveReviewStatus({ ...insp, version: 2 }, [], yes, Date.parse('2019-12-01')), 'awaiting_tenant');
check('Open dispute beats a confirmation -> disputed', deriveReviewStatus(insp, [{ inspectionId: 'i1', status: 'open' }], yes), 'disputed');
check('All disputes closed -> resolved', deriveReviewStatus(insp, [{ inspectionId: 'i1', status: 'resolved' }], []), 'resolved');

const moveIn = [
  { id: 'a', room: 'Kitchen', name: 'Cupboard', quantity: 2, condition: 'Good', photos: [{ url: 'x' }] },
  { id: 'b', room: 'Hall', name: 'Bulb', quantity: 3, condition: 'Good' },
  { id: 'c', room: 'Hall', name: 'AC', quantity: 1, condition: 'Good' },
  { id: 'd', room: 'Bath', name: 'Mirror', quantity: 1, condition: 'Good' },
];
const moveOut = [
  { id: 'x1', baseItemId: 'a', room: 'Kitchen', name: 'Cupboard', quantity: 2, condition: 'Good', photos: [] },
  { id: 'x2', baseItemId: 'b', quantity: 2, condition: 'Good', photos: [{ url: 'p' }] },
  { id: 'x3', baseItemId: 'c', quantity: 1, condition: 'Damaged', photos: [] },
  { id: 'x5', room: 'Hall', name: 'Heater', quantity: 1, condition: 'Good', photos: [] },
];
const r = compareInspections(moveIn, moveOut, [{ id: 'ch1', room: 'Hall', itemName: 'Heater' }],
  [{ type: 'Main entrance keys', handedOver: 3 }], [{ type: 'Main entrance keys', returned: 2 }]);
const kind = id => (r.flags.find(f => f.id === id) || {}).kind;
check('Unchanged item counted as a match', r.matches, 1);
check('Bulbs 3 -> 2 flagged as quantity changed', kind('b'), 'quantity_changed');
check('AC Good -> Damaged (no photo) flagged for review', kind('c'), 'needs_review');
check('Mirror absent at move-out flagged as missing', kind('d'), 'missing');
check('Heater not in move-in flagged as new/replaced', kind('new-x5'), 'new_or_replaced');
check('3 keys given, 2 returned flagged', kind('device-main-entrance-keys'), 'access_device_difference');
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
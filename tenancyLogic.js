// ===== Royal Chotham tenancy logic (identical copy used by app, admin page and server) =====
const CONDITIONS = ['Good', 'Working but worn', 'Damaged', 'Faulty / not working', 'Missing', 'Other'];
const CATEGORIES = ['Fixture', 'Fitting', 'Appliance', 'Furniture', 'Equipment', 'Door / lock', 'Lighting', 'Plumbing', 'Other'];
const COND_RANK = { 'Good': 0, 'Working but worn': 1, 'Other': 1, 'Damaged': 2, 'Faulty / not working': 2, 'Missing': 3 };

const REVIEW_LABELS = {
  awaiting_tenant: 'Awaiting tenant review',
  confirmed: 'Confirmed',
  disputed: 'Disputed — awaiting Royal Chotham review',
  resolution_provided: 'Resolution provided — awaiting tenant response',
  escalated: 'Escalated to senior staff',
  resolved: 'Resolved',
  overdue: 'Overdue — awaiting tenant review',
};
const REVIEW_COLORS = {
  awaiting_tenant: '#1565c0', confirmed: '#2e7d32', disputed: '#c62828',
  resolution_provided: '#e65100', escalated: '#6a1b9a', resolved: '#2e7d32', overdue: '#c62828',
};
const FLAG_LABELS = {
  missing: 'Missing', quantity_changed: 'Quantity changed', condition_changed: 'Condition changed',
  new_or_replaced: 'New or replaced item', access_device_difference: 'Access device difference', needs_review: 'Needs review',
};
const STAFF_DECISIONS = {
  normal_wear: 'Normal wear and tear', pre_existing: 'Pre-existing damage', approved_change: 'Approved replacement/change',
  agreed_tenant_change: 'Agreed tenant change', further_action: 'Requires further action', no_issue: 'No issue',
};

function toMillis(v) {
  if (!v) return null;
  if (typeof v === 'string') { const n = Date.parse(v); return isNaN(n) ? null : n; }
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v.seconds != null) return v.seconds * 1000;
  if (v._seconds != null) return v._seconds * 1000;
  if (v instanceof Date) return v.getTime();
  return null;
}

// Review status is DERIVED from the records, so it can never say "confirmed"
// while a dispute is open, and silence / a missed deadline is never confirmation.
function deriveReviewStatus(inspection, disputes, responses, nowMs) {
  nowMs = nowMs || Date.now();
  const mine = (disputes || []).filter(d => d.inspectionId === inspection.id);
  if (mine.some(d => d.status === 'escalated')) return 'escalated';
  if (mine.some(d => d.status === 'open')) return 'disputed';
  if (mine.some(d => d.status === 'resolution_provided')) return 'resolution_provided';
  if (mine.length > 0) return 'resolved';
  const answered = (responses || []).some(r =>
    r.inspectionId === inspection.id && (r.kind === 'confirm' || r.kind === 'agree') &&
    Number(r.reportVersion) === Number(inspection.version || 1));
  if (answered) return 'confirmed';
  const dl = toMillis(inspection.reviewDeadline);
  if (dl && nowMs > dl) return 'overdue';
  return 'awaiting_tenant';
}

const norm = s => String(s || '').trim().toLowerCase();

// Compares the move-out inspection with the move-in inventory + recorded changes.
// It only FLAGS differences. It never decides fault, liability or charges.
function compareInspections(moveInItems, moveOutItems, changes, handoverDevices, devicesReturned) {
  const flags = [];
  let matches = 0;
  changes = changes || [];
  const snap = it => it ? { quantity: Number(it.quantity), condition: it.condition, notes: it.notes || '', photos: it.photos || [] } : null;
  const related = (room, name, baseId) => changes
    .filter(c => (baseId && c.linkedItemId === baseId) || (norm(c.room) === norm(room) && norm(c.itemName) === norm(name)))
    .map(c => c.id);
  const outByBase = {};
  (moveOutItems || []).forEach(o => { if (o.baseItemId) outByBase[o.baseItemId] = o; });

  (moveInItems || []).forEach(mi => {
    const mo = outByBase[mi.id];
    let kind = null, summary = '';
    if (!mo || mo.condition === 'Missing' || Number(mo.quantity) === 0) {
      kind = 'missing'; summary = `${mi.name} was recorded at move-in (qty ${mi.quantity}) but is not present at move-out.`;
    } else if (Number(mo.quantity) !== Number(mi.quantity)) {
      kind = 'quantity_changed'; summary = `Quantity changed from ${mi.quantity} to ${mo.quantity}.`;
    } else if ((COND_RANK[mo.condition] ?? 1) > (COND_RANK[mi.condition] ?? 0) || (mo.condition === 'Other' && mi.condition !== 'Other')) {
      kind = 'condition_changed'; summary = `Condition changed from "${mi.condition}" to "${mo.condition}".`;
    }
    if (!kind) { matches++; return; }
    const rel = related(mi.room, mi.name, mi.id);
    let reason = '';
    let finalKind = kind;
    if (rel.length) { finalKind = 'needs_review'; reason = 'A recorded tenant change/agreement relates to this item.'; }
    else if (mo && !(mo.photos && mo.photos.length) && kind !== 'missing') { finalKind = 'needs_review'; reason = 'No move-out photograph to support the recorded condition.'; }
    flags.push({
      id: mi.id, kind: finalKind, baseKind: kind, reason, room: mi.room, itemName: mi.name,
      moveInItemId: mi.id, moveOutItemId: mo ? mo.id : null,
      moveIn: snap(mi), moveOut: snap(mo), summary, relatedChangeIds: rel,
      staffDecision: null, staffNote: '',
    });
  });

  (moveOutItems || []).filter(o => !o.baseItemId).forEach(o => {
    const rel = related(o.room, o.name, null);
    flags.push({
      id: 'new-' + o.id, kind: 'new_or_replaced', baseKind: 'new_or_replaced',
      reason: rel.length ? 'Matches a recorded tenant change — review the agreement.' : 'Not in the original inventory and no recorded change found.',
      room: o.room, itemName: o.name, moveInItemId: null, moveOutItemId: o.id,
      moveIn: null, moveOut: snap(o), summary: `${o.name} (qty ${o.quantity}) is present at move-out but not in the move-in inventory.`,
      relatedChangeIds: rel, staffDecision: null, staffNote: '',
    });
  });

  const retBy = {};
  (devicesReturned || []).forEach(d => { retBy[norm(d.type)] = d; });
  (handoverDevices || []).forEach(h => {
    const given = Number(h.handedOver || 0);
    const r = retBy[norm(h.type)];
    const back = r ? Number(r.returned || 0) : 0;
    if (given > 0 && back < given) {
      flags.push({
        id: 'device-' + norm(h.type).replace(/[^a-z0-9]+/g, '-'), kind: 'access_device_difference', baseKind: 'access_device_difference', reason: '',
        room: 'Access devices', itemName: h.type, moveInItemId: null, moveOutItemId: null,
        moveIn: { quantity: given, condition: '', notes: h.notes || '', photos: [] },
        moveOut: { quantity: back, condition: r ? (r.condition || '') : '', notes: r ? (r.notes || '') : '', photos: [] },
        summary: `${given} ${h.type} handed over; ${back} returned.`, relatedChangeIds: [], staffDecision: null, staffNote: '',
      });
    }
  });
  return { flags, matches };
}

module.exports = { CONDITIONS, REVIEW_LABELS, FLAG_LABELS, STAFF_DECISIONS, toMillis, deriveReviewStatus, compareInspections };
// Royal Chotham — Tenancy server
// Jobs: PDF reports + email, in-app notifications, review reminders, overdue alerts, tenancy-expiry reminders.
// Runs on your laptop now (npm start). Later it can be deployed unchanged to any cloud host (Render, Railway, Cloud Run...).
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const PDFDocument = require('pdfkit');
const crypto = require('crypto');
const { REVIEW_LABELS, FLAG_LABELS, STAFF_DECISIONS, toMillis, deriveReviewStatus } = require('./tenancyLogic');

admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- helpers
const clean = s => String(s == null ? '' : s).replace(/₦/g, 'NGN ').replace(/[^\u0009\u000A\u0020-\u007E\u00A0-\u00FF]/g, '');
const fmtDate = v => { const m = toMillis(v); return m ? new Date(m).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '-'; };
const fmtDateTime = v => { const m = toMillis(v); return m ? new Date(m).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-'; };
const docs = snap => snap.docs.map(d => ({ id: d.id, ...d.data() }));

let transporter = null;
function getTransporter() {
  if (!process.env.SMTP_HOST) throw new Error('SMTP is not configured in .env');
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}
async function sendMail(to, subject, text, attachments) {
  return getTransporter().sendMail({ from: process.env.MAIL_FROM, to, subject, text, attachments });
}
// Best-effort email: never throws (in-app notification is the reliable channel).
async function tryMail(to, subject, text) {
  if (!to) return;
  try { await sendMail(to, subject, text); } catch (e) { console.warn('Email not sent:', e.message); }
}

async function notify({ toUid, toRole, tenancyId, type, title, body }) {
  await db.collection('notifications').add({ toUid: toUid || null, toRole: toRole || null, tenancyId, type, title, body, createdAt: FV.serverTimestamp(), readAt: null });
}
async function audit(tenancyId, action, details) {
  await db.collection('tenancies').doc(tenancyId).collection('audit').add({
    at: FV.serverTimestamp(), actorUid: 'system', actorName: 'System', actorRole: 'system', action, details: details || {},
  });
}

// ---------------------------------------------------------------- PDF
const cld = (url, w) => (url && url.includes('/upload/')) ? url.replace('/upload/', `/upload/w_${w || 500},c_limit,f_jpg,q_auto/`) : url;
async function fetchImg(url) {
  try { const r = await fetch(cld(url)); if (!r.ok) return null; return Buffer.from(await r.arrayBuffer()); } catch { return null; }
}

function reviewStatement(status, ctx) {
  const resp = ctx.responses.filter(r => r.inspectionId === ctx.insp.id && (r.kind === 'confirm' || r.kind === 'agree')).pop();
  switch (status) {
    case 'confirmed': return `The tenant CONFIRMED this record on ${fmtDateTime(resp && resp.at)}${resp && resp.typedName ? ` (typed name: ${clean(resp.typedName)}, in-app acknowledgement)` : ''}.`;
    case 'resolved': return 'The tenant raised discrepancies on this record. They have been reviewed and closed - see "Disputes and outcomes" below.';
    case 'disputed': case 'escalated': case 'resolution_provided':
      return 'NOT CONFIRMED. The tenant has raised discrepancies that remain unresolved (listed below). This report must not be read as tenant agreement.';
    case 'overdue': return 'NOT CONFIRMED. The tenant review deadline has passed without a response. Silence is not agreement.';
    default: return 'NOT CONFIRMED. The tenant has not yet confirmed this record. This report must not be read as tenant agreement.';
  }
}

async function buildPdf(c) {
  const { tenancy: t, insp, items, disputes, responses, comparison, changes, version, isUpdate, prevVersion } = c;
  const isOut = insp.type === 'move_out';
  const status = deriveReviewStatus(insp, disputes, responses);
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Royal Chotham ${isOut ? 'Move-out' : 'Move-in'} Report` } });
  const chunks = []; doc.on('data', d => chunks.push(d));
  const done = new Promise(r => doc.on('end', () => r(Buffer.concat(chunks))));
  const need = h => { if (doc.y + h > doc.page.height - 60) doc.addPage(); };
  const H1 = s => { need(40); doc.moveDown(0.6).font('Helvetica-Bold').fontSize(13).fillColor('#5A4625').text(clean(s)); doc.moveDown(0.2).fillColor('#000'); };
  const P = (s, o) => { doc.font('Helvetica').fontSize(10).fillColor('#222').text(clean(s), o); };
  const B = s => doc.font('Helvetica-Bold').fontSize(10).fillColor('#000').text(clean(s));

  doc.font('Helvetica-Bold').fontSize(20).fillColor('#5A4625').text('ROYAL CHOTHAM');
  doc.fontSize(14).fillColor('#000').text(isOut ? 'Move-out Inspection & Comparison Report' : 'Property Inventory - Move-in Report');
  if (isUpdate) {
    doc.moveDown(0.4).fontSize(10).fillColor('#c62828').text(`UPDATED REPORT - Version ${version}. This replaces version ${prevVersion}. The original report and the audit history are preserved.`);
  }
  doc.moveDown(0.4).fillColor('#000');
  H1('Property and tenancy');
  P(`Property: ${t.propertyTitle || ''} - ${t.propertyLocation || ''}`);
  P(`Tenant: ${t.tenantName || ''} (${t.tenantEmail || ''})`);
  P(`Move-in date: ${t.moveInDate || '-'}    Expected move-out: ${t.expectedMoveOutDate || '-'}`);
  P(`Inspection: ${isOut ? 'Move-out' : 'Move-in'}, ${fmtDateTime(insp.inspectedAt)}, recorded by ${insp.staffName || '-'}`);
  P(`Report version: ${version}    Generated: ${fmtDateTime(Date.now())}`);

  H1('Tenant review status');
  B(REVIEW_LABELS[status] || status);
  P(reviewStatement(status, c));
  if (insp.reviewDeadline) P(`Review deadline: ${fmtDate(insp.reviewDeadline)}`);

  const open = disputes.filter(d => d.inspectionId === insp.id && d.status !== 'resolved');
  if (!isOut && (open.length || (t.handover && t.handover.unresolvedNote))) {
    H1('Unresolved discrepancies documented');
    open.forEach(d => P(`- ${d.itemLabel}: ${d.reason} [${REVIEW_LABELS[d.status === 'open' ? 'disputed' : d.status] || d.status}]`));
    if (t.handover && t.handover.unresolvedNote) P(`Staff note at handover: ${t.handover.unresolvedNote}`);
  }

  // Inventory
  H1(isOut ? 'Move-out inventory' : 'Room-by-room inventory');
  const rooms = {};
  items.forEach(i => { (rooms[i.room || 'Other'] = rooms[i.room || 'Other'] || []).push(i); });
  for (const room of Object.keys(rooms)) {
    need(50); doc.moveDown(0.3).font('Helvetica-Bold').fontSize(11).fillColor('#1a5e3c').text(clean(room)); doc.fillColor('#000');
    for (const it of rooms[room]) {
      need(60);
      B(`${it.name}  (${it.category || 'Item'})`);
      P(`Quantity: ${it.quantity}   Condition: ${it.condition}${it.notes ? `   Notes: ${it.notes}` : ''}${it.tenantNote ? `   Tenant remark at inspection: ${it.tenantNote}` : ''}`);
      const photos = (it.photos || []).slice(0, 3);
      if (photos.length) {
        const imgs = (await Promise.all(photos.map(p => fetchImg(p.url)))).filter(Boolean);
        if (imgs.length) {
          need(95); const y = doc.y + 3; let x = 40;
          imgs.forEach(b => { try { doc.image(b, x, y, { fit: [120, 85] }); } catch {} x += 128; });
          doc.y = y + 90; doc.x = 40;
        }
      }
      doc.moveDown(0.3);
    }
  }

  // Devices
  H1(isOut ? 'Keys and access devices (handed over vs returned)' : 'Keys and access devices handed over');
  const devs = (t.handover && t.handover.devices) || [];
  if (!isOut) {
    if (t.handover && t.handover.status === 'handed_over') {
      devs.forEach(d => P(`- ${d.type}: ${d.handedOver} handed over (${d.available} available)${d.notes ? ` - ${d.notes}` : ''}`));
      P(`Handover recorded: ${fmtDateTime(t.handover.at)}`);
    } else P('Key handover has not been recorded yet.');
  } else {
    const ret = insp.devicesReturned || [];
    devs.forEach(d => { const r = ret.find(x => x.type === d.type); P(`- ${d.type}: ${d.handedOver} handed over, ${r ? r.returned : 0} returned${r && r.condition ? ` (${r.condition})` : ''}`); });
    if (!devs.length) P('No access devices were recorded at handover.');
  }

  if (changes.length) {
    H1('Recorded changes and agreements during the tenancy');
    changes.forEach(ch => {
      P(`- ${ch.itemName} (${ch.room}) - ${ch.changeType}, ${ch.date || ''}. Approval: ${String(ch.approvalStatus || '').replace(/_/g, ' ')}. At move-out: ${String(ch.remainAtMoveOut || '').replace(/_/g, ' ')}.${ch.paidBy ? ` Paid by: ${ch.paidBy}.` : ''}${ch.rentDeduction ? ` Rent deduction: ${ch.rentDeduction}.` : ''}${ch.agreementNote ? ` Agreement: ${ch.agreementNote}` : ''}`);
    });
  }

  if (isOut && comparison) {
    H1('Comparison with the move-in record');
    P(`Basis: move-in inventory review status at the time of comparison was "${REVIEW_LABELS[comparison.basisStatus] || comparison.basisStatus}". ${comparison.matches} item(s) matched.`);
    P('The items below are FLAGS FOR REVIEW only. They are not findings of fault, liability or charges.');
    for (const f of comparison.flags) {
      need(110);
      B(`${FLAG_LABELS[f.kind] || f.kind}: ${f.itemName} (${f.room})`);
      P(f.summary + (f.reason ? ` ${f.reason}` : ''));
      P(`Staff decision: ${f.staffDecision ? STAFF_DECISIONS[f.staffDecision] : 'Not yet reviewed'}${f.staffNote ? ` - ${f.staffNote}` : ''}`);
      const urls = [...((f.moveIn && f.moveIn.photos) || []).slice(0, 1), ...((f.moveOut && f.moveOut.photos) || []).slice(0, 1)].map(p => p.url);
      if (urls.length) {
        const imgs = (await Promise.all(urls.map(fetchImg))).filter(Boolean);
        if (imgs.length) { need(95); const y = doc.y + 3; let x = 40; imgs.forEach(b => { try { doc.image(b, x, y, { fit: [120, 85] }); } catch {} x += 128; }); doc.y = y + 90; doc.x = 40; }
      }
      doc.moveDown(0.3);
    }
  }

  const myDisputes = disputes.filter(d => d.inspectionId === insp.id);
  if (myDisputes.length) {
    H1('Disputes and outcomes');
    myDisputes.forEach(d => {
      need(70);
      B(`${d.itemLabel} - ${REVIEW_LABELS[d.status === 'open' ? 'disputed' : d.status] || d.status}`);
      P(`Tenant reason: ${d.reason}`);
      if (d.staffFindings) P(`Royal Chotham findings: ${d.staffFindings}${d.proposedCorrection ? ` Proposed correction: ${d.proposedCorrection}` : ''}`);
      if (d.tenantResponse) P(`Tenant response: ${d.tenantResponse === 'accepted' ? 'Accepted the resolution' : 'Continues to disagree'}${d.tenantResponseNote ? ` - ${d.tenantResponseNote}` : ''}`);
      if (d.seniorDetermination) P(`Senior review determination: ${d.seniorDetermination}. Reasons: ${d.seniorReasons}`);
      doc.moveDown(0.3);
    });
  }
  const comments = responses.filter(r => r.inspectionId === insp.id && r.kind === 'comment');
  if (comments.length) { H1('Tenant comments'); comments.forEach(r => P(`${fmtDateTime(r.at)}: ${r.text}`)); }

  doc.moveDown(1).font('Helvetica-Oblique').fontSize(8).fillColor('#666')
    .text('This report records the condition of the property at inspection. Differences are flagged for human review and do not by themselves establish tenant fault or liability. Normal wear and tear, pre-existing damage and approved changes are considered by Royal Chotham staff.');
  doc.end();
  return done;
}

async function uploadPdf(buf, name) {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME, key = process.env.CLOUDINARY_API_KEY, secret = process.env.CLOUDINARY_API_SECRET;
  if (!cloud || !key || !secret) throw new Error('Cloudinary is not configured in .env');
  const ts = Math.floor(Date.now() / 1000);
  const public_id = `tenancy-reports/${name}.pdf`;
  const signature = crypto.createHash('sha1').update(`public_id=${public_id}&timestamp=${ts}${secret}`).digest('hex');
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/pdf' }), `${name}.pdf`);
  fd.append('api_key', key); fd.append('timestamp', String(ts)); fd.append('public_id', public_id); fd.append('signature', signature);
  const r = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/raw/upload`, { method: 'POST', body: fd });
  const j = await r.json();
  if (!j.secure_url) throw new Error('Cloudinary upload failed: ' + (j.error && j.error.message));
  return j.secure_url;
}

const locks = new Set();
async function sendReport(tenancyId, inspectionId, actor) {
  const lockKey = `${tenancyId}/${inspectionId}`;
  if (locks.has(lockKey)) throw new Error('A report for this inspection is already being generated.');
  locks.add(lockKey);
  try {
    const tRef = db.collection('tenancies').doc(tenancyId);
    const tSnap = await tRef.get();
    if (!tSnap.exists) throw new Error('Tenancy not found');
    const tenancy = { id: tSnap.id, ...tSnap.data() };
    const iSnap = await tRef.collection('inspections').doc(inspectionId).get();
    if (!iSnap.exists) throw new Error('Inspection not found');
    const insp = { id: iSnap.id, ...iSnap.data() };
    if (insp.status !== 'completed') throw new Error('The inspection must be completed before a report is sent.');
    const [items, disputes, responses, changes, reports] = await Promise.all([
      tRef.collection('inspections').doc(inspectionId).collection('items').get().then(docs),
      tRef.collection('disputes').get().then(docs),
      tRef.collection('responses').get().then(docs),
      tRef.collection('changes').get().then(docs),
      tRef.collection('reports').where('inspectionId', '==', inspectionId).get().then(docs),
    ]);
    let comparison = null;
    if (insp.type === 'move_out') { const c = await tRef.collection('comparisons').doc(inspectionId).get(); comparison = c.exists ? c.data() : null; }
    const version = reports.length + 1;
    const pdf = await buildPdf({ tenancy, insp, items, disputes, responses, comparison, changes, version, isUpdate: version > 1, prevVersion: version - 1 });
    const status = deriveReviewStatus(insp, disputes, responses);
    const url = await uploadPdf(pdf, `${tenancyId}-${insp.type}-v${version}-${crypto.randomBytes(6).toString('hex')}`);
    const repRef = await tRef.collection('reports').add({
      inspectionId, type: insp.type, version, isUpdate: version > 1, pdfUrl: url, reviewStatusAtGeneration: status,
      generatedAt: FV.serverTimestamp(), generatedBy: actor ? actor.name : 'System',
      email: { to: tenancy.tenantEmail, status: 'pending', attemptedAt: null, error: null },
    });
    await emailReport(tenancy, repRef, pdf, insp, version, status);
    await audit(tenancyId, 'report_generated', { reportId: repRef.id, inspectionId, version, by: actor ? actor.name : 'System' });
    return { reportId: repRef.id, version, pdfUrl: url };
  } finally { locks.delete(lockKey); }
}

async function emailReport(tenancy, repRef, pdf, insp, version, status) {
  const label = insp.type === 'move_out' ? 'move-out inspection and comparison report' : 'move-in inspection report';
  const subject = `${version > 1 ? 'UPDATED ' : ''}Royal Chotham - your ${label}${version > 1 ? ` (version ${version})` : ''}`;
  const text = `Dear ${tenancy.tenantName || 'Tenant'},\n\nPlease find attached the ${label} for ${tenancy.propertyTitle || 'your property'}.\n\n` +
    `Review status: ${REVIEW_LABELS[status] || status}.\n` +
    (status === 'confirmed' ? '' : 'Please note: this record has NOT been confirmed by you, and nothing in this report should be read as your agreement.\n') +
    (version > 1 ? `\nThis is an updated version. The earlier version and the audit history are preserved.\n` : '') +
    `\nYou can also view this report in the Royal Chotham app (Tenancy tab).\n\nRoyal Chotham`;
  const attemptedAt = FV.serverTimestamp();
  try {
    await sendMail(tenancy.tenantEmail, subject, text, [{ filename: `royal-chotham-${insp.type}-report-v${version}.pdf`, content: pdf }]);
    await repRef.update({ email: { to: tenancy.tenantEmail, status: 'sent', attemptedAt, error: null } });
  } catch (e) {
    await repRef.update({ email: { to: tenancy.tenantEmail, status: 'failed', attemptedAt, error: String(e.message).slice(0, 300) } });
    await notify({ toRole: 'staff', tenancyId: tenancy.id, type: 'report_email_failed', title: 'Report email failed', body: `The ${label} for ${tenancy.tenantName} could not be emailed. Please follow up (Reports tab > Resend).` });
    await tryMail(process.env.STAFF_NOTIFY_EMAIL, 'Royal Chotham: report email failed', `The ${label} for ${tenancy.tenantName} (${tenancy.tenantEmail}) could not be emailed: ${e.message}`);
  }
}

// ---------------------------------------------------------------- real-time listeners
async function tenancyOf(docSnap) {
  const ref = docSnap.ref.parent.parent;
  const t = await ref.get();
  return t.exists ? { id: t.id, ...t.data() } : null;
}

async function handleDispute(snap) {
  const d = snap.data(); const t = await tenancyOf(snap); if (!t) return;
  if (d.status === 'open' && d.staffNotified === false) {
    await snap.ref.update({ staffNotified: true });
    await notify({ toRole: 'staff', tenancyId: t.id, type: 'dispute_raised', title: 'Tenant disputed an item', body: `${t.tenantName} disputed "${d.itemLabel}" at ${t.propertyTitle}.` });
    await tryMail(process.env.STAFF_NOTIFY_EMAIL, 'Royal Chotham: tenant dispute raised', `${t.tenantName} disputed "${d.itemLabel}" (${t.propertyTitle}).\n\nReason: ${d.reason}`);
  }
  if (d.status === 'escalated' && d.seniorNotified === false) {
    await snap.ref.update({ seniorNotified: true });
    await notify({ toRole: 'senior', tenancyId: t.id, type: 'dispute_escalated', title: 'Dispute escalated for senior review', body: `${t.tenantName} still disagrees about "${d.itemLabel}" (${t.propertyTitle}).` });
    await tryMail(process.env.SENIOR_NOTIFY_EMAIL || process.env.STAFF_NOTIFY_EMAIL, 'Royal Chotham: dispute escalated', `${t.tenantName} continues to disagree about "${d.itemLabel}" (${t.propertyTitle}). Senior review is required.`);
  }
  if (d.status === 'resolution_provided' && d.resolutionNotified === false) {
    await snap.ref.update({ resolutionNotified: true });
    await notify({ toUid: t.tenantUid, tenancyId: t.id, type: 'resolution_provided', title: 'Royal Chotham has responded to your dispute', body: `Please review the response about "${d.itemLabel}" and tell us if you accept it.` });
    await tryMail(t.tenantEmail, 'Royal Chotham: response to your dispute', `Dear ${t.tenantName},\n\nWe have reviewed your dispute about "${d.itemLabel}". Please open the Royal Chotham app (Tenancy tab) to read our response and tell us whether you accept it.`);
  }
  if (d.status === 'resolved' && d.seniorUid && d.outcomeNotified === false) {
    await snap.ref.update({ outcomeNotified: true });
    await notify({ toUid: t.tenantUid, tenancyId: t.id, type: 'senior_outcome', title: 'Senior review outcome recorded', body: `A determination has been recorded about "${d.itemLabel}". Open the app to read it.` });
    await tryMail(t.tenantEmail, 'Royal Chotham: senior review outcome', `Dear ${t.tenantName},\n\nA senior review determination has been recorded about "${d.itemLabel}". Please open the Royal Chotham app (Tenancy tab) to read it.`);
  }
}

async function handleInspection(snap) {
  const i = snap.data(); if (i.status !== 'completed' || i.readyNotifiedAt) return;
  const t = await tenancyOf(snap); if (!t) return;
  await snap.ref.update({ readyNotifiedAt: FV.serverTimestamp() });
  const what = i.type === 'move_out' ? 'move-out report' : 'move-in inventory';
  const dl = fmtDate(i.reviewDeadline);
  await notify({ toUid: t.tenantUid, tenancyId: t.id, type: 'ready_for_review', title: `Your ${what} is ready for review`, body: `Please review it in the app by ${dl}.` });
  await tryMail(t.tenantEmail, `Royal Chotham: your ${what} is ready for review`, `Dear ${t.tenantName},\n\nYour ${what} for ${t.propertyTitle} is ready. Please open the Royal Chotham app, go to the Tenancy tab, and review it by ${dl}.\n\nIf you do not respond, the record will be marked overdue. It will never be treated as your agreement.`);
}

function startListeners() {
  const wrap = fn => snap => snap.docChanges().forEach(ch => { if (ch.type !== 'removed') fn(ch.doc).catch(e => console.error('listener error', e.message)); });
  db.collectionGroup('disputes').onSnapshot(wrap(handleDispute), e => console.error('disputes listener', e.message));
  db.collectionGroup('inspections').onSnapshot(wrap(handleInspection), e => console.error('inspections listener', e.message));
}

// ---------------------------------------------------------------- hourly sweep
async function sweep() {
  console.log('Sweep started', new Date().toISOString());
  const tens = await db.collection('tenancies').get();
  for (const tdoc of tens.docs) {
    try {
      const t = { id: tdoc.id, ...tdoc.data() };
      const [insps, disputes, responses, reports] = await Promise.all([
        tdoc.ref.collection('inspections').where('status', '==', 'completed').get().then(docs),
        tdoc.ref.collection('disputes').get().then(docs),
        tdoc.ref.collection('responses').get().then(docs),
        tdoc.ref.collection('reports').get().then(docs),
      ]);
      for (const i of insps) {
        const ref = tdoc.ref.collection('inspections').doc(i.id);
        const status = deriveReviewStatus(i, disputes, responses);
        const what = i.type === 'move_out' ? 'move-out report' : 'move-in inventory';
        const dl = toMillis(i.reviewDeadline);
        if (status === 'awaiting_tenant' && dl) {
          const daysLeft = Math.ceil((dl - Date.now()) / DAY);
          const sent = i.remindersSent || [];
          for (const rd of (t.reminderDaysBefore || [3, 1])) {
            if (daysLeft === rd && !sent.includes(rd)) {
              await ref.update({ remindersSent: FV.arrayUnion(rd) });
              await notify({ toUid: t.tenantUid, tenancyId: t.id, type: 'reminder', title: `Reminder: review your ${what}`, body: `The deadline is ${fmtDate(dl)} (${rd} day${rd > 1 ? 's' : ''} left).` });
              await tryMail(t.tenantEmail, `Reminder: please review your ${what}`, `Dear ${t.tenantName},\n\nThis is a reminder to review your ${what} in the Royal Chotham app by ${fmtDate(dl)}.`);
            }
          }
        }
        if (status === 'overdue' && !i.overdueNotified) {
          await ref.update({ overdueNotified: true });
          await notify({ toRole: 'staff', tenancyId: t.id, type: 'review_overdue', title: 'Tenant review overdue', body: `${t.tenantName} has not reviewed the ${what} for ${t.propertyTitle}. Follow-up needed. (Not treated as agreement.)` });
          await notify({ toUid: t.tenantUid, tenancyId: t.id, type: 'review_overdue', title: `Your ${what} review is overdue`, body: 'Please open the app and review it. It has not been treated as agreement.' });
          await tryMail(process.env.STAFF_NOTIFY_EMAIL, 'Royal Chotham: tenant review overdue', `${t.tenantName} has not reviewed the ${what} for ${t.propertyTitle}. Please follow up. This is not treated as agreement.`);
        }
        const hasReport = reports.some(r => r.inspectionId === i.id);
        const ready = i.type === 'move_out' || (t.handover && t.handover.status === 'handed_over');
        if (!hasReport && ready) {
          await sendReport(t.id, i.id, null).catch(e => console.error('Auto report failed', t.id, i.id, e.message));
        }
      }
      const exp = toMillis(t.expectedMoveOutDate);
      const win = Number(process.env.EXPIRY_REMINDER_DAYS || 30) * DAY;
      if (t.status === 'active' && exp && exp - Date.now() < win && exp > Date.now() && !t.expiryReminderSent) {
        await tdoc.ref.update({ expiryReminderSent: true });
        await notify({ toRole: 'staff', tenancyId: t.id, type: 'expiry', title: 'Tenancy ending soon', body: `${t.tenantName}'s tenancy at ${t.propertyTitle} ends on ${fmtDate(exp)}.` });
        await notify({ toUid: t.tenantUid, tenancyId: t.id, type: 'expiry', title: 'Your tenancy end date is approaching', body: `Expected end date: ${fmtDate(exp)}.` });
        await tryMail(process.env.STAFF_NOTIFY_EMAIL, 'Royal Chotham: tenancy ending soon', `${t.tenantName}'s tenancy at ${t.propertyTitle} ends on ${fmtDate(exp)}.`);
      }
    } catch (e) { console.error('Sweep error for', tdoc.id, e.message); }
  }
}

// ---------------------------------------------------------------- API
const app = express();
app.use(cors());
app.use(express.json());

async function requireStaff(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!tok) return res.status(401).json({ error: 'Missing token' });
    const dec = await admin.auth().verifyIdToken(tok);
    if (dec.staff !== true) return res.status(403).json({ error: 'Staff access only' });
    req.actor = { uid: dec.uid, name: dec.name || dec.email, email: dec.email };
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

app.get('/health', (_, res) => res.json({ ok: true }));

app.post('/api/reports/send', requireStaff, async (req, res) => {
  try {
    const { tenancyId, inspectionId } = req.body || {};
    if (!tenancyId || !inspectionId) return res.status(400).json({ error: 'tenancyId and inspectionId are required' });
    res.json(await sendReport(tenancyId, inspectionId, req.actor));
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/reports/resend', requireStaff, async (req, res) => {
  try {
    const { tenancyId, reportId } = req.body || {};
    const tRef = db.collection('tenancies').doc(tenancyId);
    const [t, r] = await Promise.all([tRef.get(), tRef.collection('reports').doc(reportId).get()]);
    if (!t.exists || !r.exists) return res.status(404).json({ error: 'Not found' });
    const tenancy = t.data(), rep = r.data();
    const pdf = Buffer.from(await (await fetch(rep.pdfUrl)).arrayBuffer());
    const attemptedAt = FV.serverTimestamp();
    try {
      await sendMail(tenancy.tenantEmail, `${rep.isUpdate ? 'UPDATED ' : ''}Royal Chotham - your inspection report`, 'Please find your inspection report attached. You can also view it in the Royal Chotham app (Tenancy tab). This report does not imply your agreement unless it states that you confirmed it.', [{ filename: `royal-chotham-report-v${rep.version}.pdf`, content: pdf }]);
      await r.ref.update({ email: { to: tenancy.tenantEmail, status: 'sent', attemptedAt, error: null } });
      await audit(tenancyId, 'report_email_resent', { reportId, by: req.actor.name });
      res.json({ ok: true });
    } catch (e) {
      await r.ref.update({ email: { to: tenancy.tenantEmail, status: 'failed', attemptedAt, error: String(e.message).slice(0, 300) } });
      res.status(502).json({ error: 'Email failed: ' + e.message });
    }
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Tenancy server running on http://localhost:${PORT}`);
  startListeners();
  cron.schedule('0 * * * *', () => sweep().catch(e => console.error(e)));
  setTimeout(() => sweep().catch(e => console.error(e)), 15000);
});
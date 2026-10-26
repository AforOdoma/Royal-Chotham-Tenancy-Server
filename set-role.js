// Usage:  node set-role.js someone@example.com staff
//         node set-role.js someone@example.com senior
//         node set-role.js someone@example.com both
//         node set-role.js someone@example.com none
require('dotenv').config();
const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.applicationDefault() });

(async () => {
  const [email, role] = process.argv.slice(2);
  if (!email || !['staff', 'senior', 'both', 'none'].includes(role)) {
    console.log('Usage: node set-role.js <email> <staff|senior|both|none>');
    process.exit(1);
  }
  const user = await admin.auth().getUserByEmail(email);
  const claims = { ...(user.customClaims || {}) };
  delete claims.staff; delete claims.senior;
  if (role === 'staff' || role === 'both') claims.staff = true;
  if (role === 'senior' || role === 'both') claims.senior = true;
  await admin.auth().setCustomUserClaims(user.uid, claims);
  console.log(`Done. ${email} is now: ${role}. They must sign out and back in for it to apply.`);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
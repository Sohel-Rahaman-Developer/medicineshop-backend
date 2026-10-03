// Lost the authenticator phone: `npm run admin:reset-totp -- <email> "<reason>"` on the server.
// Server access is the proof; the next sign-in (email code) shows a fresh QR. Every session of that admin ends.
import { connectDb, disconnectDb } from '../src/config/db';
import { AdminAuditModel, AdminSessionModel, AdminUserModel } from '../src/modules/admin/admin.model';

async function main() {
  const [email = '', ...rest] = process.argv.slice(2);
  const reason = rest.join(' ').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || reason.length < 5) {
    process.stderr.write('Usage: npm run admin:reset-totp -- <email> "<reason, 5+ letters>"\n');
    process.exit(1);
  }
  await connectDb();
  const admin = await AdminUserModel.findOne({ email: email.toLowerCase() });
  if (!admin) {
    process.stderr.write(`${email} is not on the platform team.\n`);
    process.exitCode = 1;
  } else {
    admin.set({ totpSecretEnc: undefined, totpEnabledAt: undefined, totpLastStep: 0 });
    await admin.save();
    const ended = await AdminSessionModel.updateMany({ adminUserId: admin._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    await AdminAuditModel.create({ adminUserId: admin._id, adminName: admin.name, action: 'totp_reset', reason, text: 'authenticator reset on the server (admin:reset-totp)' });
    process.stdout.write(`Authenticator cleared for ${admin.name}; ${String(ended.modifiedCount)} session(s) ended. Next sign-in: email code, then scan a new QR.\n`);
  }
  await disconnectDb();
}

main().catch((err: unknown) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});

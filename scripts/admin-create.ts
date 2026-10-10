// The first platform admin: `npm run admin:create -- owner@medbox24.in "Sohel Rahaman"`. They set up the authenticator on first sign-in.
import { connectDb, disconnectDb } from '../src/config/db';
import { AdminUserModel } from '../src/modules/admin/admin.model';

async function main() {
  const [email = '', ...rest] = process.argv.slice(2);
  const name = rest.join(' ').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || name.length < 2) {
    process.stderr.write('Usage: npm run admin:create -- <email> "<full name>"\n');
    process.exit(1);
  }
  await connectDb();
  const exists = await AdminUserModel.findOne({ email: email.toLowerCase() }).lean();
  if (exists) process.stdout.write(`${email} is already on the platform team (${exists.role}).\n`);
  else {
    await AdminUserModel.create({ email, name, role: 'super', invitedBy: 'admin:create' });
    process.stdout.write(`Added ${name} <${email}> as super admin. Sign in at the admin app with an email code, then set up the authenticator.\n`);
  }
  await disconnectDb();
}

main().catch((err: unknown) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});

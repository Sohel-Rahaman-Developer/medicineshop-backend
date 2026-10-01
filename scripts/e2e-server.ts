// API for the frontend Playwright suite: real app on :5000 + in-memory DB; a localhost-only helper on :5099 seeds OTPs.
import http from 'node:http';
import { crash, startHarness } from './lib/harness';

const API_PORT = Number(process.env.E2E_API_PORT ?? 5000);
const HELPER_PORT = Number(process.env.E2E_HELPER_PORT ?? 5099);

async function main() {
  process.env.PORT = String(API_PORT);
  // Every Playwright project signs in from the same IP; the per-email limits stay real.
  process.env.RATE_OTP_REQUEST_PER_IP ??= '1000';
  const h = await startHarness({ port: API_PORT });

  const helper = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/otp') {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const { email, code } = JSON.parse(raw) as { email: string; code: string };
      h.seedOtp(email, code).then(
        () => res.writeHead(204).end(),
        (err: unknown) => res.writeHead(500).end(String(err)),
      );
    });
  });
  helper.listen(HELPER_PORT, '127.0.0.1');
  process.stdout.write(`e2e API on :${API_PORT}, OTP helper on 127.0.0.1:${HELPER_PORT}\n`);

  const stop = () => {
    helper.close();
    void h.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(crash);

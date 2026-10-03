import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHANGELOG } from './changelog';

interface Deployed {
  deployedAt?: string;
  commits?: { backend?: string; shop?: string; admin?: string };
}

// The API runs from the backend folder (PM2 cwd, npm scripts); deploy.sh writes release.json there.
const read = (file: string): unknown => {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed names in the app folder
    return JSON.parse(readFileSync(join(process.cwd(), file), 'utf8'));
  } catch {
    return null;
  }
};

const deployed = read('release.json') as Deployed | null;
const startedAt = new Date().toISOString();

export const VERSION = (read('package.json') as { version?: string } | null)?.version ?? '0.0.0';

/** What is live: version, when deploy.sh put it there (else when this process started) and each repo's commit. */
export const release = () => ({
  version: VERSION,
  deployedAt: deployed?.deployedAt ?? startedAt,
  commits: { backend: deployed?.commits?.backend ?? null, shop: deployed?.commits?.shop ?? null, admin: deployed?.commits?.admin ?? null },
});

/** For the shop app: only what a shop would notice, newest first. */
export const shopNotes = () => CHANGELOG.filter((n) => n.shop.length).map((n) => ({ version: n.version, date: n.date, title: n.title, items: n.shop }));

import { allowedOrigins } from '../config/env';

// Our fixed apps, plus any origin a module vouches for (a shop's live web address, D94).
let more: (origin: string) => Promise<boolean> = () => Promise.resolve(false);

export const trustMoreOrigins = (check: (origin: string) => Promise<boolean>) => {
  more = check;
};

export async function isOurOrigin(origin: string | undefined): Promise<boolean> {
  if (!origin) return false;
  return allowedOrigins.includes(origin) || more(origin);
}

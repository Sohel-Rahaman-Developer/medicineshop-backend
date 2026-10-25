import { allowedOrigins } from '../config/env';
import { AppError } from './errors';

// Our fixed apps, plus any origin a module vouches for (a shop's live web address, D94).
let more: (origin: string) => Promise<boolean> = () => Promise.resolve(false);
// A shop's own address speaks for that one shop only.
let shopOf: (origin: string) => Promise<string | null> = () => Promise.resolve(null);

export const trustMoreOrigins = (check: (origin: string) => Promise<boolean>, shop: (origin: string) => Promise<string | null>) => {
  more = check;
  shopOf = shop;
};

export async function isOurOrigin(origin: string | undefined): Promise<boolean> {
  if (!origin) return false;
  return allowedOrigins.includes(origin) || more(origin);
}

/** The shop whose own address the request came from; null on the main app. */
export const originShop = (origin: string | undefined): Promise<string | null> => (origin ? shopOf(origin) : Promise.resolve(null));

export const otherShopAddress = () => AppError.forbidden('This web address is for another shop. Open your own shop’s address, or the main MedBox24 site.');

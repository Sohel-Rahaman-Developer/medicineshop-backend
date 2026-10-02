import mongoose, { type ClientSession } from 'mongoose';

/** Runs `work` in a MongoDB transaction; write conflicts retry automatically (PLAN §12 atomicity). */
export async function inTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(() => work(session));
  } finally {
    await session.endSession();
  }
}

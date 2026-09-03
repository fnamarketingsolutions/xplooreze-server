import type { ClientSession } from 'mongoose';

import { getMongoose } from './connection';

/**
 * Runs work in a MongoDB session transaction, then commits or aborts
 * and ends the session. Callers decide when a transaction is required.
 */
export async function withTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  const mongoose = getMongoose();
  return mongoose.connection.transaction((session) => work(session));
}

export async function startSession(): Promise<ClientSession> {
  const mongoose = getMongoose();
  return mongoose.startSession();
}

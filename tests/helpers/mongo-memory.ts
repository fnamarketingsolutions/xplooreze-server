import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import { AuthSessionModel } from '../../src/database/models/auth-session.model';
import { PasswordResetTokenModel } from '../../src/database/models/password-reset-token.model';
import { UserModel } from '../../src/database/models/user.model';

let mongo: MongoMemoryReplSet | null = null;

export async function startMemoryMongo(): Promise<void> {
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  await mongoose.connect(mongo.getUri());
  await UserModel.createIndexes();
  await AuthSessionModel.createIndexes();
  await PasswordResetTokenModel.createIndexes();
}

export async function stopMemoryMongo(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  if (mongo) {
    await mongo.stop();
    mongo = null;
  }
}

export async function clearMemoryMongo(): Promise<void> {
  const collections = mongoose.connection.collections;

  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
}

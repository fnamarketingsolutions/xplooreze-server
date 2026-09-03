import 'dotenv/config';

import type { Types } from 'mongoose';

import { loadConfig } from '../config/index';
import { connectDatabase, disconnectDatabase } from '../database/index';
import { AttemptModel, EntitlementModel } from '../database/models/index';
import { getLogger } from '../shared/logger/logger';

const logger = getLogger({ module: 'backfill-attempt-entitlements' });
const LEGACY_ATTEMPT_INDEX = 'studentId_1_testSeriesId_1_attemptNumber_1';

type LegacyAttempt = {
  _id: Types.ObjectId;
  studentId: Types.ObjectId;
  testSeriesId: Types.ObjectId;
  startedAt: Date;
};

/**
 * Attaches an entitlement to attempts predating per-entitlement gating, then renumbers
 * attemptNumber within each entitlement so the unique {entitlementId, attemptNumber}
 * index can build.
 */
async function attachMissingEntitlements(): Promise<number> {
  const orphans = await AttemptModel.find({
    $or: [{ entitlementId: null }, { entitlementId: { $exists: false } }],
  })
    .select({ studentId: 1, testSeriesId: 1, startedAt: 1 })
    .sort({ startedAt: 1 })
    .lean<LegacyAttempt[]>()
    .exec();

  const unresolved: string[] = [];
  let attached = 0;

  for (const attempt of orphans) {
    const entitlement = await EntitlementModel.findOne({
      studentId: attempt.studentId,
      testSeriesId: attempt.testSeriesId,
      grantedAt: { $lte: attempt.startedAt },
    })
      .sort({ grantedAt: 1 })
      .select({ _id: 1 })
      .lean<{ _id: Types.ObjectId }>()
      .exec();

    if (!entitlement) {
      unresolved.push(attempt._id.toString());
      continue;
    }

    await AttemptModel.updateOne(
      { _id: attempt._id },
      { $set: { entitlementId: entitlement._id } },
    ).exec();
    attached += 1;
  }

  if (unresolved.length > 0) {
    logger.warn(
      { count: unresolved.length, attemptIds: unresolved },
      'Attempts could not be matched to an entitlement and were left untouched',
    );
  }

  return attached;
}

async function renumberPerEntitlement(): Promise<number> {
  const entitlementIds = await AttemptModel.distinct('entitlementId', {
    entitlementId: { $ne: null },
  }).exec();

  let renumbered = 0;

  for (const entitlementId of entitlementIds as Types.ObjectId[]) {
    const attempts = await AttemptModel.find({ entitlementId })
      .select({ attemptNumber: 1 })
      .sort({ startedAt: 1 })
      .lean<{ _id: Types.ObjectId; attemptNumber: number }[]>()
      .exec();

    for (const [index, attempt] of attempts.entries()) {
      const expected = index + 1;

      if (attempt.attemptNumber === expected) {
        continue;
      }

      await AttemptModel.updateOne(
        { _id: attempt._id },
        { $set: { attemptNumber: expected } },
      ).exec();
      renumbered += 1;
    }
  }

  return renumbered;
}

async function dropLegacyIndex(): Promise<boolean> {
  const indexes = await AttemptModel.collection.indexes();

  if (!indexes.some((index) => index.name === LEGACY_ATTEMPT_INDEX)) {
    return false;
  }

  await AttemptModel.collection.dropIndex(LEGACY_ATTEMPT_INDEX);
  return true;
}

async function main(): Promise<void> {
  loadConfig();
  await connectDatabase();

  try {
    // Drop first: renumbering collides with the old unique index while it still exists.
    const droppedLegacyIndex = await dropLegacyIndex();
    const attached = await attachMissingEntitlements();
    const renumbered = await renumberPerEntitlement();

    logger.info(
      { droppedLegacyIndex, attached, renumbered },
      'Attempt entitlement backfill complete',
    );
  } finally {
    await disconnectDatabase();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Attempt entitlement backfill failed';
  console.error('Attempt entitlement backfill failed:', message);
  process.exit(1);
});

import { describe, expect, it } from 'vitest';

import { parseAdminUserListQuery } from '../src/modules/users/user.validation';
import { parseAdminTestSeriesListQuery } from '../src/modules/test-series/test-series.validation';
import { ErrorCodes } from '../src/shared/errors/app-error';
import { ID_LIST_MAX_ITEMS, readObjectIdListQuery } from '../src/shared/validation/http';

const ID_A = '64b0f2c3a1d2e3f4a5b6c7d8';
const ID_B = '64b0f2c3a1d2e3f4a5b6c7d9';

function expectValidationError(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject({ code: ErrorCodes.VALIDATION_ERROR });
    return;
  }

  throw new Error('Expected a validation error.');
}

describe('readObjectIdListQuery', () => {
  it('treats a missing or blank value as no filter', () => {
    expect(readObjectIdListQuery({}, 'ids')).toBeUndefined();
    expect(readObjectIdListQuery({ ids: '' }, 'ids')).toBeUndefined();
    expect(readObjectIdListQuery({ ids: '   ' }, 'ids')).toBeUndefined();
  });

  it('parses a comma-separated list, trimming and de-duplicating', () => {
    expect(readObjectIdListQuery({ ids: ID_A }, 'ids')).toEqual([ID_A]);
    expect(readObjectIdListQuery({ ids: ` ${ID_A} , ${ID_B} ` }, 'ids')).toEqual([ID_A, ID_B]);
    expect(readObjectIdListQuery({ ids: `${ID_A},${ID_A}` }, 'ids')).toEqual([ID_A]);
  });

  it('ignores empty segments but rejects a list of only separators', () => {
    expect(readObjectIdListQuery({ ids: `${ID_A},,${ID_B}` }, 'ids')).toEqual([ID_A, ID_B]);
    expectValidationError(() => readObjectIdListQuery({ ids: ',,,' }, 'ids'));
  });

  it('rejects malformed ids', () => {
    expectValidationError(() => readObjectIdListQuery({ ids: 'not-an-id' }, 'ids'));
    expectValidationError(() => readObjectIdListQuery({ ids: `${ID_A},not-an-id` }, 'ids'));
  });

  it('rejects a repeated query parameter', () => {
    expectValidationError(() => readObjectIdListQuery({ ids: [ID_A, ID_B] }, 'ids'));
  });

  it(`accepts at most ${ID_LIST_MAX_ITEMS} ids`, () => {
    const atLimit = Array.from(
      { length: ID_LIST_MAX_ITEMS },
      (_, index) => `64b0f2c3a1d2e3f4a5b6${index.toString().padStart(4, '0')}`,
    );

    expect(readObjectIdListQuery({ ids: atLimit.join(',') }, 'ids')).toHaveLength(
      ID_LIST_MAX_ITEMS,
    );
    expectValidationError(() =>
      readObjectIdListQuery({ ids: [...atLimit, ID_A].join(',') }, 'ids'),
    );
  });
});

describe('admin list query batch lookup', () => {
  it('omits ids from the user list query when absent', () => {
    expect(parseAdminUserListQuery({})).toEqual({});
    expect(parseAdminUserListQuery({ ids: `${ID_A},${ID_B}` })).toEqual({ ids: [ID_A, ID_B] });
  });

  it('omits ids from the test series list query when absent', () => {
    expect(parseAdminTestSeriesListQuery({})).not.toHaveProperty('ids');
    expect(parseAdminTestSeriesListQuery({ ids: ID_A })).toMatchObject({ ids: [ID_A] });
  });

  it('rejects malformed ids on both admin list endpoints', () => {
    expectValidationError(() => parseAdminUserListQuery({ ids: 'nope' }));
    expectValidationError(() => parseAdminTestSeriesListQuery({ ids: 'nope' }));
  });
});

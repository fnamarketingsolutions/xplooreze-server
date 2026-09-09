import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { ErrorCodes } from '../src/shared/errors/app-error';
import { toEvaluatorCategoryAssignmentDto } from '../src/modules/evaluator-assignments/evaluator-assignment.dto';
import {
  parseCreateEvaluatorCategoryAssignmentInput,
  parseEvaluatorCategoryAssignmentListQuery,
  parseGroupedEvaluatorCategoryAssignmentListQuery,
  parseUpdateEvaluatorCategoryAssignmentInput,
} from '../src/modules/evaluator-assignments/evaluator-assignment.validation';
import { toAdminUserDto } from '../src/modules/users/user.dto';
import {
  parseCreateAdminUserInput,
  parseUpdateAdminUserInput,
} from '../src/modules/users/user.validation';

const evaluatorId = new Types.ObjectId().toString();
const categoryId = new Types.ObjectId().toString();

describe('Phase 12 unit rules', () => {
  it('accepts Admin-created ADMIN and EVALUATOR users and rejects other roles', () => {
    const evaluator = parseCreateAdminUserInput({
      email: 'Eva.Luator@Example.com ',
      password: 'password12',
      role: 'EVALUATOR',
      mobileNumber: '+919876543210',
      name: { first: 'Eva', last: 'Luator' },
    });
    expect(evaluator).toEqual({
      email: 'eva.luator@example.com',
      password: 'password12',
      role: 'EVALUATOR',
      mobileNumber: '+919876543210',
      name: { first: 'Eva', last: 'Luator' },
    });

    expect(
      parseCreateAdminUserInput({
        email: 'admin@example.com',
        password: 'password12',
        role: 'ADMIN',
        mobileNumber: '+919876543211',
        name: { first: 'Ada', last: 'Min' },
      }).role,
    ).toBe('ADMIN');

    try {
      parseCreateAdminUserInput({
        email: 'student@example.com',
        password: 'password12',
        role: 'STUDENT',
        mobileNumber: '+919876543212',
        name: { first: 'Stu', last: 'Dent' },
      });
      throw new Error('expected student role to fail');
    } catch (error) {
      expect((error as { code: string }).code).toBe(ErrorCodes.VALIDATION_ERROR);
    }

    try {
      parseCreateAdminUserInput({
        email: 'x@example.com',
        password: 'password12',
        role: 'SUPER_ADMIN',
        mobileNumber: '+919876543213',
        name: { first: 'X', last: 'Y' },
      });
      throw new Error('expected super admin role to fail');
    } catch (error) {
      expect((error as { code: string }).code).toBe(ErrorCodes.VALIDATION_ERROR);
    }
  });

  it('limits user PATCH to role, status, and mobileNumber and rejects other fields', () => {
    expect(parseUpdateAdminUserInput({ role: 'STUDENT', status: 'DISABLED' })).toEqual({
      role: 'STUDENT',
      status: 'DISABLED',
    });
    expect(parseUpdateAdminUserInput({ mobileNumber: '+919876543210' })).toEqual({
      mobileNumber: '+919876543210',
    });

    for (const body of [
      { email: 'other@example.com' },
      { password: 'password12' },
      { passwordHash: 'hash' },
      { name: { first: 'A', last: 'B' } },
      { deletedAt: null },
      { createdAt: new Date().toISOString() },
      { $set: { role: 'ADMIN' } },
    ]) {
      expect(() => parseUpdateAdminUserInput(body)).toThrow();
    }
  });

  it('omits authentication secrets from admin user DTOs', () => {
    const dto = toAdminUserDto({
      _id: { toString: () => evaluatorId },
      email: 'admin@example.com',
      role: 'ADMIN',
      status: 'ACTIVE',
      name: { first: 'Ada', last: 'Min' },
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      passwordHash: 'hashed-secret',
      refreshTokenHash: 'refresh-secret',
    } as never);

    expect(dto).toEqual({
      id: evaluatorId,
      email: 'admin@example.com',
      mobileNumber: null,
      role: 'ADMIN',
      status: 'ACTIVE',
      name: { first: 'Ada', last: 'Min' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(dto).not.toHaveProperty('passwordHash');
    expect(dto).not.toHaveProperty('password');
    expect(dto).not.toHaveProperty('refreshTokenHash');
    expect(JSON.stringify(dto)).not.toContain('hashed-secret');
    expect(JSON.stringify(dto)).not.toContain('refresh-secret');
  });

  it('creates assignment input with evaluatorId and categoryId only', () => {
    expect(parseCreateEvaluatorCategoryAssignmentInput({ evaluatorId, categoryId })).toEqual({
      evaluatorId,
      categoryId,
    });

    expect(() =>
      parseCreateEvaluatorCategoryAssignmentInput({
        evaluatorId,
        categoryId,
        isActive: false,
      }),
    ).toThrow();
    expect(() =>
      parseCreateEvaluatorCategoryAssignmentInput({
        evaluatorId,
        categoryId,
        $set: { isActive: true },
      }),
    ).toThrow();
  });

  it('limits assignment PATCH to isActive', () => {
    expect(parseUpdateEvaluatorCategoryAssignmentInput({ isActive: false })).toEqual({
      isActive: false,
    });
    expect(() => parseUpdateEvaluatorCategoryAssignmentInput({ evaluatorId })).toThrow();
    expect(() =>
      parseUpdateEvaluatorCategoryAssignmentInput({ isActive: true, categoryId }),
    ).toThrow();
  });

  it('omits authentication secrets from assignment evaluator identity', () => {
    const dto = toEvaluatorCategoryAssignmentDto(
      {
        _id: { toString: () => 'assignment-id' },
        evaluatorId: { toString: () => evaluatorId },
        categoryId: { toString: () => categoryId },
        isActive: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      },
      {
        _id: { toString: () => evaluatorId },
        email: 'evaluator@example.com',
        role: 'EVALUATOR',
        status: 'ACTIVE',
        name: { first: 'Eva', last: 'Luator' },
        passwordHash: 'hashed-secret',
      } as never,
      { _id: { toString: () => categoryId }, name: 'Mathematics' },
    );

    expect(dto.evaluator).toEqual({
      id: evaluatorId,
      email: 'evaluator@example.com',
      mobileNumber: null,
      role: 'EVALUATOR',
      status: 'ACTIVE',
      name: { first: 'Eva', last: 'Luator' },
    });
    expect(JSON.stringify(dto)).not.toContain('hashed-secret');
    expect(dto.category).toEqual({ id: categoryId, name: 'Mathematics' });
  });

  it('parses assignment list and grouped list query filters', () => {
    expect(parseEvaluatorCategoryAssignmentListQuery({})).toEqual({
      categoryId: undefined,
      evaluatorId: undefined,
    });
    expect(
      parseEvaluatorCategoryAssignmentListQuery({ categoryId, evaluatorId }),
    ).toEqual({ categoryId, evaluatorId });

    expect(parseGroupedEvaluatorCategoryAssignmentListQuery({})).toEqual({
      categoryId: undefined,
      evaluatorId: undefined,
      isActive: undefined,
    });
    expect(
      parseGroupedEvaluatorCategoryAssignmentListQuery({
        categoryId,
        evaluatorId,
        isActive: 'false',
      }),
    ).toEqual({ categoryId, evaluatorId, isActive: false });
    expect(() => parseGroupedEvaluatorCategoryAssignmentListQuery({ isActive: 'yes' })).toThrow();
  });
});

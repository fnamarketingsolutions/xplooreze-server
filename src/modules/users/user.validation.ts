import type { UserRole, UserStatus } from '../../database/models/enums';
import {
  asRecord,
  readObjectIdListQuery,
  readQueryValue,
  readRouteParam,
  readString,
  readTrimmedString,
  rejectUnknownFields,
  requireAtLeastOneField,
  validationError,
} from '../../shared/validation/http';
import { NAME_MAX_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../auth/auth.validation';
import { isValidEmail, normalizeEmail } from '../auth/email';

const CREATE_FIELDS = ['name', 'email', 'password', 'role'] as const;
const UPDATE_FIELDS = ['role', 'status'] as const;

export type PrivilegedRole = 'ADMIN' | 'EVALUATOR';

export type CreateAdminUserInput = {
  email: string;
  password: string;
  role: PrivilegedRole;
  name: {
    first: string;
    last: string;
  };
};

export type UpdateAdminUserInput = {
  role?: UserRole;
  status?: UserStatus;
};

export type AdminUserListQuery = {
  ids?: string[];
  role?: UserRole;
  status?: UserStatus;
  search?: string;
};

function validatePassword(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw validationError({
      password: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
    });
  }

  if (password.length > PASSWORD_MAX_LENGTH) {
    throw validationError({
      password: `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`,
    });
  }
}

function validateNamePart(value: unknown, field: string): string {
  return readTrimmedString(value, field, NAME_MAX_LENGTH);
}

function readPrivilegedRole(value: unknown, field: string): PrivilegedRole {
  if (value !== 'ADMIN' && value !== 'EVALUATOR') {
    throw validationError({ [field]: 'Must be ADMIN or EVALUATOR.' });
  }

  return value;
}

function readUserRole(value: unknown, field: string): UserRole {
  if (value !== 'STUDENT' && value !== 'EVALUATOR' && value !== 'ADMIN') {
    throw validationError({ [field]: 'Must be STUDENT, EVALUATOR, or ADMIN.' });
  }

  return value;
}

function readUserStatus(value: unknown, field: string): UserStatus {
  if (value !== 'ACTIVE' && value !== 'DISABLED') {
    throw validationError({ [field]: 'Must be ACTIVE or DISABLED.' });
  }

  return value;
}

export function parseCreateAdminUserInput(body: unknown): CreateAdminUserInput {
  const record = asRecord(body);
  rejectUnknownFields(record, CREATE_FIELDS);

  const email = normalizeEmail(readString(record.email, 'email'));

  if (!isValidEmail(email)) {
    throw validationError({ email: 'Invalid email.' });
  }

  const password = readString(record.password, 'password');
  validatePassword(password);

  const nameValue = record.name;
  if (nameValue === null || typeof nameValue !== 'object' || Array.isArray(nameValue)) {
    throw validationError({ name: 'Name must include first and last.' });
  }

  const name = nameValue as Record<string, unknown>;

  return {
    email,
    password,
    role: readPrivilegedRole(record.role, 'role'),
    name: {
      first: validateNamePart(name.first, 'name.first'),
      last: validateNamePart(name.last, 'name.last'),
    },
  };
}

export function parseUpdateAdminUserInput(body: unknown): UpdateAdminUserInput {
  const record = asRecord(body);
  rejectUnknownFields(record, UPDATE_FIELDS);
  requireAtLeastOneField(record, UPDATE_FIELDS);

  return {
    ...(record.role !== undefined ? { role: readUserRole(record.role, 'role') } : {}),
    ...(record.status !== undefined ? { status: readUserStatus(record.status, 'status') } : {}),
  };
}

export function parseAdminUserListQuery(query: object): AdminUserListQuery {
  const record = query as Record<string, unknown>;
  const ids = readObjectIdListQuery(record, 'ids');
  const role = readQueryValue(record, 'role');
  const status = readQueryValue(record, 'status');
  const search = readQueryValue(record, 'search');

  return {
    ...(ids ? { ids } : {}),
    ...(role === undefined || role.trim() === ''
      ? {}
      : { role: readUserRole(role, 'role') }),
    ...(status === undefined || status.trim() === ''
      ? {}
      : { status: readUserStatus(status, 'status') }),
    ...(search === undefined || search.trim() === '' ? {} : { search: search.trim() }),
  };
}

export function parseUserId(value: string | string[] | undefined): string {
  return readRouteParam(value, 'userId');
}

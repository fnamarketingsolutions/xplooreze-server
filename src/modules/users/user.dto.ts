import type { UserRole, UserStatus } from '../../database/models/enums';

export type AdminUserDto = {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  name: {
    first: string;
    last: string;
  };
  createdAt: string;
  updatedAt: string;
};

type UserLike = {
  _id: { toString(): string };
  email: string;
  role: UserRole;
  status: UserStatus;
  name: {
    first: string;
    last: string;
  };
  createdAt: Date;
  updatedAt: Date;
};

export function toAdminUserDto(user: UserLike): AdminUserDto {
  return {
    id: user._id.toString(),
    email: user.email,
    role: user.role,
    status: user.status,
    name: {
      first: user.name.first,
      last: user.name.last,
    },
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

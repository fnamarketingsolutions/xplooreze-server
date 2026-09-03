import type { UserRole, UserStatus } from '../../database/models/enums';

export type SafeUser = {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  name: {
    first: string;
    last: string;
  };
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
};

export function toSafeUser(user: UserLike): SafeUser {
  return {
    id: user._id.toString(),
    email: user.email,
    role: user.role,
    status: user.status,
    name: {
      first: user.name.first,
      last: user.name.last,
    },
  };
}

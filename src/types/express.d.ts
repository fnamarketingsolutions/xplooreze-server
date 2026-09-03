import type { Request } from 'express';

import type { UserRole, UserStatus } from '../database/models/enums';

export type AuthContext = {
  userId: string;
  role: UserRole;
  status: UserStatus;
  sessionId: string;
};

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthContext;
      rawBody?: Buffer;
    }
  }
}

export type RequestWithId = Request & {
  requestId: string;
};

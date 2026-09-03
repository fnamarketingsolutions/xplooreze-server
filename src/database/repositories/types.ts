import type { ClientSession } from 'mongoose';

export type SessionOption = {
  session?: ClientSession;
};

export type ListOptions = SessionOption & {
  skip?: number;
  limit?: number;
  sort?: Record<string, 1 | -1>;
};

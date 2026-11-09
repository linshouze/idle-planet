import type { SessionUser } from './services/auth.ts';

export type Env = { Variables: { user: SessionUser } };

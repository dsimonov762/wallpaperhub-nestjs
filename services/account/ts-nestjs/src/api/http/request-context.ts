import { AsyncLocalStorage } from 'node:async_hooks';
import type { Locale } from '../../i18n/i18n.service.js';

/**
 * Per-request data that any layer may need (logging, audit, errors) without
 * passing it through every function call. AsyncLocalStorage is Node's built-in
 * "thread-local for async code".
 */
export interface RequestContext {
  requestId: string;
  traceId: string;
  locale: Locale;
  /** Set by the security layer later (JWT `sub`). */
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const currentContext = (): RequestContext | undefined =>
  storage.getStore();

/** Runs `fn` with `ctx` as the current context (everything `fn` triggers sees it). */
export const runInContext = <T>(ctx: RequestContext, fn: () => T): T =>
  storage.run(ctx, fn);

import type { Principal } from './principal.js';

/**
 * gRPC has no request object we may attach things to, but every call carries its own `Metadata` instance.
 * The auth guard files the verified caller under that instance; handlers and interceptors look it up.
 * A WeakMap lets the entry disappear together with the call.
 */
const byCall = new WeakMap<object, Principal>();

export const setCallPrincipal = (call: object, principal: Principal): void => {
  byCall.set(call, principal);
};

export const callPrincipal = (call: object): Principal | undefined =>
  byCall.get(call);

import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { UnauthorizedException } from '../domain/exceptions/app.exception.js';
import type { Permission } from './permissions.js';
import type { Principal } from './principal.js';

export const PUBLIC_KEY = 'auth:public';
export const ROLES_KEY = 'auth:roles';
export const PERMISSIONS_KEY = 'auth:permissions';

/** Everything requires a valid token by default. `@Public()` opts a route out (registration, login helpers). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Caller needs ANY ONE of these realm roles. */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

/** Caller needs ALL of these permissions (derived from their roles, see permissions.ts). */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Injects the verified caller into a controller method: `me(@CurrentPrincipal() who: Principal)`. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal => {
    const principal = ctx.switchToHttp().getRequest<FastifyRequest>().principal;
    if (!principal) throw new UnauthorizedException(); // only possible on a @Public() route: a coding mistake
    return principal;
  },
);

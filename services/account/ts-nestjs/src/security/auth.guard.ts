import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Metadata } from '@grpc/grpc-js';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import {
  ForbiddenException,
  UnauthorizedException,
} from '../domain/exceptions/app.exception.js';
import { LOGGER } from '../infra/logger.js';
import { PERMISSIONS_KEY, PUBLIC_KEY, ROLES_KEY } from './decorators.js';
import { setCallPrincipal } from './principal-store.js';
import { type Permission, permissionsOf } from './permissions.js';
import { TokenVerifier } from './token-verifier.js';

/** `Authorization: Bearer <jwt>`: strict shape, scheme is case-insensitive. */
const BEARER = /^Bearer ([\w\-.~+/]+=*)$/i;

/**
 * Global guard: default-deny.
 *   Layer 1 (endpoint):  every route needs a valid token unless marked @Public()
 *   Layer 2 (role/perm): @Roles(...) / @RequirePermissions(...)
 *   Layer 3 (ownership): done inside handlers with assertOwnerOrPermission()
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Default-deny for any transport we have not written authentication for.
    const type = context.getType();
    if (type !== 'http' && type !== 'rpc') return false;

    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets))
      return true;

    // Where the token lives differs by transport: HTTP header vs gRPC metadata. Everything after is shared.
    const request =
      type === 'http'
        ? context.switchToHttp().getRequest<FastifyRequest>()
        : undefined;
    const metadata =
      type === 'rpc' ? context.switchToRpc().getContext<Metadata>() : undefined;
    const header = request
      ? request.headers.authorization
      : (metadata?.get('authorization')[0]?.toString() ?? undefined);

    const match = header ? BEARER.exec(header) : null;
    if (!match)
      throw new UnauthorizedException(
        header ? 'malformed_header' : 'missing_token',
      );

    let principal;
    try {
      principal = await this.verifier.verify(match[1]!);
    } catch (e) {
      if (e instanceof UnauthorizedException)
        this.logger.debug({ reason: e.reason }, 'token rejected');
      throw e;
    }
    if (request) {
      request.principal = principal;
      // The request context is shared by reference, so logs and the audit trail now know who is acting.
      if (request.ctx) request.ctx.userId = principal.userId;
    } else if (metadata) {
      setCallPrincipal(metadata, principal);
    }

    const roles = this.reflector.getAllAndOverride<string[] | undefined>(
      ROLES_KEY,
      targets,
    );
    if (roles?.length && !roles.some((r) => principal.roles.includes(r)))
      throw new ForbiddenException();

    const needed = this.reflector.getAllAndOverride<Permission[] | undefined>(
      PERMISSIONS_KEY,
      targets,
    );
    if (needed?.length) {
      const granted = permissionsOf(principal.roles);
      if (!needed.every((p) => granted.has(p))) throw new ForbiddenException();
    }
    return true;
  }
}

import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiAuthenticated } from '../api/http/openapi/decorators.js';
import { WhoAmIDto } from '../api/http/openapi/schemas.js';
import { CurrentPrincipal } from './decorators.js';
import { permissionsOf } from './permissions.js';
import type { Principal } from './principal.js';

/** Shows what the service understood from your token. Handy for learning and for debugging 401/403. */
@ApiTags('Identity')
@ApiAuthenticated()
@Controller('whoami')
export class WhoAmIController {
  @ApiOperation({
    summary:
      'Identity, roles and permissions the service derived from your token (learning/debugging aid)',
  })
  @ApiOkResponse({ description: 'OK', type: WhoAmIDto })
  @Get()
  whoAmI(@CurrentPrincipal() who: Principal) {
    return {
      id: who.userId,
      username: who.username,
      roles: who.roles,
      permissions: [...permissionsOf(who.roles)].sort(),
      service: who.isService,
      clientId: who.clientId ?? null,
      expiresAt: who.expiresAt.toISOString(),
    };
  }
}

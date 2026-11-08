import { Module } from '@nestjs/common';
import { RegistrationController } from './api/http/registration.controller.js';
import { UsersController } from './api/http/users.controller.js';
import { IdentityProvider } from './domain/identity-provider.js';
import { RegistrationService } from './domain/registration.service.js';
import { UserService } from './domain/user.service.js';
import { KeycloakAdminClient } from './infra/keycloak/keycloak-admin.client.js';
import { OutboxModule } from './repository/outbox.module.js';
import { ProfileCache } from './repository/profile-cache.js';
import { UserRepository } from './repository/user.repository.js';
import { ResilienceModule } from './resilience/resilience.module.js';
import { Clock, SystemClock } from './util/clock.js';

/** Registration, profiles and account deletion (README phase 1, step 1.3). */
@Module({
  imports: [OutboxModule, ResilienceModule],
  controllers: [RegistrationController, UsersController],
  exports: [UserService, UserRepository, ProfileCache],
  providers: [
    RegistrationService,
    UserService,
    UserRepository,
    ProfileCache,
    { provide: IdentityProvider, useClass: KeycloakAdminClient },
    { provide: Clock, useClass: SystemClock },
  ],
})
export class UsersModule {}

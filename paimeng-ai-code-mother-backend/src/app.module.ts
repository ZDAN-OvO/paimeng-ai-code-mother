import { Module } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core'
import { ZodValidationPipe } from 'nestjs-zod'
import { AgentService } from './agent/agent.service'
import { SessionStoreService } from './agent/session-store.service'
import { AppsController } from './apps/apps.controller'
import { AppsService } from './apps/apps.service'
import { AuthController } from './auth/auth.controller'
import { AuthService } from './auth/auth.service'
import { SessionService } from './auth/session.service'
import { AuthGuard, EnvelopeInterceptor, GlobalExceptionFilter, OriginGuard } from './common/http'
import { AppConfigModule } from './config/config.module'
import { ConversationsController } from './conversations/conversations.controller'
import { ConversationsService } from './conversations/conversations.service'
import { DbModule } from './db/db.module'
import { HealthController } from './health/health.controller'
import { PreviewController } from './preview/preview.controller'
import { PreviewService } from './preview/preview.service'
import { RedisModule } from './redis/redis.module'
import { RunsController } from './runs/runs.controller'
import { RunsService } from './runs/runs.service'
import { RunDetailsService } from './runs/run-details.service'
import { AppMutexService } from './runtime/app-mutex.service'
import { DependencyService } from './runtime/dependency.service'
import { DockerService } from './runtime/docker.service'
import { FileService } from './runtime/file-service'
import { RegistryRelayService } from './runtime/registry-relay.service'
import { RuntimeService } from './runtime/runtime.service'
import { SkillService } from './skills/skill.service'
import { StartupService } from './startup/startup.service'
import { InstanceLockService } from './startup/instance-lock.service'
import { ToolRegistryService } from './tools/tool-registry.service'

@Module({
  imports: [AppConfigModule, DbModule, RedisModule],
  controllers: [
    AuthController,
    AppsController,
    ConversationsController,
    RunsController,
    PreviewController,
    HealthController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: OriginGuard },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    AuthService,
    SessionService,
    AppsService,
    ConversationsService,
    SessionStoreService,
    AgentService,
    RunsService,
    RunDetailsService,
    ToolRegistryService,
    SkillService,
    DependencyService,
    FileService,
    AppMutexService,
    DockerService,
    RegistryRelayService,
    RuntimeService,
    PreviewService,
    InstanceLockService,
    StartupService,
  ],
})
export class AppModule {}

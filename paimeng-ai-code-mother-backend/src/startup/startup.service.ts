import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common'
import { AppsService } from '../apps/apps.service'
import { PreviewService } from '../preview/preview.service'
import { RunsService } from '../runs/runs.service'
import { RuntimeService } from '../runtime/runtime.service'
import { SkillService } from '../skills/skill.service'

@Injectable()
export class StartupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StartupService.name)

  constructor(
    private readonly runs: RunsService,
    private readonly apps: AppsService,
    private readonly runtime: RuntimeService,
    private readonly preview: PreviewService,
    private readonly skills: SkillService,
  ) {}

  async onApplicationBootstrap() {
    const skillErrors = await this.skills.validateAll()
    if (skillErrors.length > 0) {
      this.logger.error(`技能注册表存在无效项：${skillErrors.join('; ')}`)
    }
    const interrupted = await this.runs.markInterrupted()
    if (interrupted > 0) this.logger.warn(`已将 ${interrupted} 个遗留运行标记为失败（不自动续跑）`)
    const stopped = await this.runtime.stopAllProjectContainers()
    this.logger.log(`启动清理：停止 ${stopped} 个本项目容器`)
    const remaining = await this.runtime.remainingProjectAppIds()
    for (const appId of remaining) {
      await this.apps.markExecBlocked(appId, true)
      this.logger.error(`应用 ${appId} 仍有无法确认停止的容器，已封锁新运行`)
    }
    await this.preview.resetStates()
    const resumed = await this.apps.resumePendingDeletes()
    if (resumed > 0) this.logger.log(`恢复 ${resumed} 个待删除应用`)
  }
}

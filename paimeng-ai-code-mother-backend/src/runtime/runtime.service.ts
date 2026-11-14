import { Injectable, Logger, OnModuleInit } from '@nestjs/common'

import { existsSync, mkdirSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { connect } from 'node:net'
import { request } from 'node:http'
import { join } from 'node:path'
import semver from 'semver'
import { AppConfigService } from '../config/config.module'
import { DockerService } from './docker.service'
import { inspectProject, Manifest, stableDependencyHash, validateManifest } from './dependency-policy'
import { RegistryRelayService } from './registry-relay.service'
import { swapNodeModules } from './dependency-swap'
import { pruneLogDir, truncateLogTail } from './log-retention'

export interface RuntimeResult {
  ok: boolean
  logs: string
  error?: string
  durationMs: number
  timedOut?: boolean
}

type CancelCheck = () => boolean

const CANCEL_POLL_MS = 200

function taskLabel(kind: 'install' | 'build' | 'typecheck') {
  if (kind === 'install') return '依赖安装'
  if (kind === 'typecheck') return '静态检查'
  return '构建'
}

@Injectable()
export class RuntimeService implements OnModuleInit {
  private readonly logger = new Logger(RuntimeService.name)
  private imageName: string | null = null
  private imageError: string | null = null
  private readonly taskContainers = new Map<number, string>()

  constructor(
    private readonly config: AppConfigService,
    private readonly docker: DockerService,
    private readonly relay: RegistryRelayService,
  ) {}

  async onModuleInit() {
    await mkdir(this.config.sourceRoot, { recursive: true })
    await mkdir(this.config.depsRoot, { recursive: true })
    await mkdir(this.config.buildRoot, { recursive: true })
    await mkdir(this.config.taskLogRoot, { recursive: true })
    try {
      await this.docker.ensureNetwork(this.config.appNetwork, true)
    } catch (err) {
      this.logger.warn(`应用网络不可用: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (this.config.setupImageOnStart) {
      try {
        this.imageName = await this.docker.ensureRuntimeImage()
      } catch (err) {
        this.imageError = err instanceof Error ? err.message : String(err)
        this.logger.warn(`运行时镜像不可用: ${this.imageError}`)
      }
    }
  }

  get runtimeImageStatus() {
    return { image: this.imageName, error: this.imageError }
  }

  get runtimeDir() {
    return this.config.runtimeRoot
  }

  async detectProject(appId: number) {
    return inspectProject(this.config.appSourceDir(appId))
  }

  async sourceExists(appId: number) {
    return existsSync(this.config.appSourceDir(appId))
  }

  async ensureSourceDir(appId: number) {
    const dir = this.config.appSourceDir(appId)
    await mkdir(dir, { recursive: true })
    return dir
  }

  async removeSourceDir(appId: number) {
    await rm(this.config.appSourceDir(appId), { recursive: true, force: true })
  }

  async assertCapacity(kind: 'preview' | 'task') {
    const available = this.docker.hostMemoryAvailableBytes()
    const reserve = this.config.memoryHostReserveBytes
    const need = kind === 'preview' ? 512 * 1024 * 1024 : this.config.taskMemoryBytes
    const containers = await this.docker.listProjectContainers().catch(() => [])
    const allocated = containers
      .filter((container) => container.State === 'running')
      .reduce((sum, container) => {
        if (container.Labels.includes('paimeng.kind=preview')) return sum + 512 * 1024 * 1024
        if (/paimeng\.kind=(install|build|typecheck)/.test(container.Labels)) {
          return sum + this.config.taskMemoryBytes
        }
        return sum
      }, 0)
    if (allocated + need > this.config.memoryTotalBudgetBytes) {
      const fmt = (n: number) => `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`
      throw new Error(
        `整机应用环境内存预算不足：已分配 ${fmt(allocated)}，本次需要 ${fmt(need)}，预算 ${fmt(this.config.memoryTotalBudgetBytes)}`,
      )
    }
    if (available > 0 && available < reserve + need) {
      const fmt = (n: number) => `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`
      throw new Error(`宿主可用内存不足：需要预留 ${fmt(reserve)} 并分配 ${fmt(need)}，当前可用 ${fmt(available)}`)
    }
    const free = this.docker.hostDiskFreeBytes(this.config.runtimeRoot)
    if (free > 0 && free < this.config.diskReserveBytes) {
      throw new Error(
        `磁盘空间不足：需要至少 ${Math.ceil(this.config.diskReserveBytes / 1024 / 1024)} MiB 预留，当前可用 ${Math.floor(free / 1024 / 1024)} MiB`,
      )
    }
  }

  private async ensureImage() {
    if (this.imageName) return this.imageName
    this.imageName = await this.docker.ensureRuntimeImage()
    this.imageError = null
    return this.imageName
  }

  private async writeLog(appId: number, kind: string, content: string) {
    const dir = join(this.config.taskLogRoot, String(appId))
    const maxBytes = this.config.appLogMaxBytes ?? 10 * 1024 * 1024
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
    await writeFile(file, truncateLogTail(content, maxBytes), 'utf8').catch(() => undefined)
    await pruneLogDir(dir, maxBytes)
    return file
  }

  private async runTaskContainer(
    appId: number,
    kind: 'install' | 'build' | 'typecheck',
    args: string[],
    timeoutMs: number,
    isCancelled: CancelCheck = () => false,
  ): Promise<RuntimeResult> {
    const started = Date.now()
    if (isCancelled()) {
      return { ok: false, logs: '', error: '任务已取消', durationMs: 0 }
    }
    const name = `paimeng-${kind}-${appId}`
    await this.docker.removeContainer(name)
    const res = await this.docker.run(args, { timeoutMs: 60_000, maxOutputBytes: 1024 * 1024 })
    if (res.code !== 0) {
      const logs = `${res.stdout}\n${res.stderr}`.trim()
      await this.writeLog(appId, kind, logs)
      return { ok: false, logs, error: '任务容器启动失败', durationMs: Date.now() - started }
    }
    this.taskContainers.set(appId, name)
    let envCancelRequested = false
    let removal: Promise<void> | null = null
    const stopForCancel = () => {
      envCancelRequested = true
      // 多次取消检查只触发一次删除；docker rm -f 本身是幂等的。
      removal ??= this.docker.removeContainer(name).catch(() => undefined)
    }
    if (isCancelled()) stopForCancel()
    const cancelPoll = setInterval(() => {
      if (isCancelled()) stopForCancel()
    }, CANCEL_POLL_MS)
    cancelPoll.unref?.()
    let wait: Awaited<ReturnType<DockerService['run']>>
    try {
      wait = await this.docker.run(['wait', name], { timeoutMs })
    } finally {
      clearInterval(cancelPoll)
      if (this.taskContainers.get(appId) === name) this.taskContainers.delete(appId)
    }
    if (removal) await removal
    const timedOut = wait.timedOut
    const exitCode = Number(wait.stdout.trim() || -1)
    const logs = await this.docker.containerLogs(name, 400).catch(() => '')
    await this.docker.removeContainer(name)
    await this.writeLog(appId, kind, `exit=${exitCode} timedOut=${timedOut}\n${logs}`)
    if (envCancelRequested) {
      return { ok: false, logs, error: '任务已取消', durationMs: Date.now() - started }
    }
    if (timedOut) {
      return {
        ok: false,
        logs,
        error: `${taskLabel(kind)}超时（${Math.round(timeoutMs / 1000)} 秒）`,
        durationMs: Date.now() - started,
        timedOut: true,
      }
    }
    if (exitCode !== 0) {
      return {
        ok: false,
        logs,
        error: `${taskLabel(kind)}失败（退出码 ${exitCode}）`,
        durationMs: Date.now() - started,
      }
    }
    return { ok: true, logs, durationMs: Date.now() - started }
  }

  async stopTask(appId: number) {
    const name = this.taskContainers.get(appId)
    if (!name) return
    await this.docker.removeContainer(name)
    this.taskContainers.delete(appId)
  }

  async isTaskRunning(appId: number) {
    const names = [`paimeng-install-${appId}`, `paimeng-build-${appId}`, `paimeng-typecheck-${appId}`]
    for (const name of names) {
      if (await this.docker.containerRunning(name)) return true
    }
    return false
  }

  async ensureDependencies(
    appId: number,
    isCancelled: CancelCheck = () => false,
  ): Promise<RuntimeResult & { changed: boolean; hash?: string }> {
    const started = Date.now()
    if (isCancelled()) {
      return { ok: false, changed: false, logs: '', error: '任务已取消', durationMs: 0 }
    }
    const sourceDir = this.config.appSourceDir(appId)
    const info = inspectProject(sourceDir)
    if (!info.hasPackageJson) {
      return { ok: true, changed: false, logs: '无 package.json，无需安装依赖', durationMs: 0 }
    }
    if (info.manifestError) {
      return { ok: false, changed: false, logs: '', error: info.manifestError, durationMs: Date.now() - started }
    }
    const validation = validateManifest(info.manifest as Manifest)
    if (!validation.ok) {
      return {
        ok: false,
        changed: false,
        logs: '',
        error: `依赖声明不符合平台策略: ${validation.errors.join('; ')}`,
        durationMs: Date.now() - started,
      }
    }
    const manifest = validation.filtered as Manifest
    const hash = stableDependencyHash(manifest)
    const depsDir = this.config.appDepsDir(appId)
    const markerPath = join(depsDir, '.installed.json')
    const nodeModules = join(depsDir, 'node_modules')
    let marker: { hash?: string } | null
    try {
      marker = JSON.parse(await readFile(markerPath, 'utf8')) as { hash?: string }
    } catch {
      marker = null
    }
    if (marker?.hash === hash && existsSync(nodeModules)) {
      return { ok: true, changed: false, hash, logs: '依赖已是最新', durationMs: 0 }
    }
    if (!this.relay.url) {
      return {
        ok: false,
        changed: false,
        logs: '',
        error: `npm 受限中继不可用: ${this.relay.error ?? '尚未启动'}`,
        durationMs: Date.now() - started,
      }
    }
    await this.assertCapacity('task')
    const staging = join(depsDir, 'staging')
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await writeFile(
      join(staging, '.npmrc'),
      `registry=${this.relay.url}\naudit=false\nfund=false\nupdate-notifier=false\nignore-scripts=true\n`,
      'utf8',
    )
    const image = await this.ensureImage()
    const dockerArgs = [
      'run',
      '-d',
      '--name',
      `paimeng-install-${appId}`,
      '--label',
      `${this.docker.projectLabel}=${this.docker.projectName}`,
      '--label',
      `paimeng.app=${appId}`,
      '--label',
      'paimeng.kind=install',
      '--network',
      this.config.installNetwork,
      '--user',
      '1000:1000',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=128',
      `--memory=${this.config.taskMemoryDocker}`,
      `--memory-swap=${this.config.taskMemoryDocker}`,
      '--cpus=1',
      '--tmpfs',
      '/tmp:rw,size=256m',
      '-e',
      'HOME=/tmp',
      '-e',
      'npm_config_cache=/tmp/npm-cache',
      '-e',
      'npm_config_registry=' + this.relay.url,
      '-e',
      'npm_config_audit=false',
      '-e',
      'npm_config_fund=false',
      '-v',
      `${staging}:/deps:rw`,
      '-w',
      '/deps',
      '--entrypoint',
      'npm',
      image,
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--loglevel=warn',
    ]
    const result = await this.runTaskContainer(
      appId,
      'install',
      dockerArgs,
      this.config.installTimeoutMs,
      isCancelled,
    )
    if (!result.ok) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      return { ...result, changed: false }
    }

    try {
      if (isCancelled()) {
        return {
          ok: false,
          changed: false,
          logs: result.logs,
          error: '任务已取消',
          durationMs: Date.now() - started,
        }
      }

      const installedModules = join(staging, 'node_modules')
      if (!existsSync(installedModules)) {
        return {
          ok: false,
          changed: false,
          logs: result.logs,
          error: '安装结束但 node_modules 不存在',
          durationMs: Date.now() - started,
        }
      }
      for (const [name, range] of Object.entries({
        ...(manifest.dependencies ?? {}),
        ...(manifest.devDependencies ?? {}),
      })) {
        const pkgPath = join(installedModules, ...name.split('/'), 'package.json')
        try {
          const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { version?: string }
          if (!pkg.version || !semver.satisfies(pkg.version, range)) {
            return {
              ok: false,
              changed: false,
              logs: result.logs,
              error: `安装结果 ${name}@${pkg.version ?? '未知'} 不满足声明 ${range}`,
              durationMs: Date.now() - started,
            }
          }
        } catch {
          return {
            ok: false,
            changed: false,
            logs: result.logs,
            error: `依赖 ${name} 未正确安装`,
            durationMs: Date.now() - started,
          }
        }
      }

      await swapNodeModules(
        nodeModules,
        installedModules,
        join(depsDir, `node_modules.backup-${randomBytes(6).toString('hex')}`),
      )
      await mkdir(join(nodeModules, '.vite-temp'), { recursive: true })
      const lock = join(staging, 'package-lock.json')
      if (existsSync(lock)) {
        await cp(lock, join(depsDir, 'package-lock.json'), { force: true })
      }
      await writeFile(markerPath, JSON.stringify({ hash, installedAt: new Date().toISOString() }, null, 2))
      return {
        ok: true,
        changed: true,
        hash,
        logs: result.logs,
        durationMs: Date.now() - started,
      }
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async build(appId: number, isCancelled: CancelCheck = () => false): Promise<RuntimeResult> {
    if (isCancelled()) return { ok: false, logs: '', error: '任务已取消', durationMs: 0 }
    const info = inspectProject(this.config.appSourceDir(appId))
    if (!info.hasPackageJson || !info.hasBuild) {
      return { ok: true, logs: '没有构建脚本，跳过构建', durationMs: 0 }
    }
    return this.runProjectScript(
      appId,
      'build',
      this.config.buildTimeoutMs,
      ['--', '--configLoader', 'runner'],
      isCancelled,
    )
  }

  async typecheck(appId: number, isCancelled: CancelCheck = () => false): Promise<RuntimeResult> {
    if (isCancelled()) return { ok: false, logs: '', error: '任务已取消', durationMs: 0 }
    const info = inspectProject(this.config.appSourceDir(appId))
    if (!info.hasPackageJson || !info.hasTypecheck) {
      return { ok: true, logs: '没有 typecheck 脚本，跳过静态检查', durationMs: 0 }
    }
    return this.runProjectScript(appId, 'typecheck', this.config.buildTimeoutMs, [], isCancelled)
  }

  private async runProjectScript(
    appId: number,
    script: 'build' | 'typecheck',
    timeoutMs: number,
    extraArgs: string[],
    isCancelled: CancelCheck = () => false,
  ): Promise<RuntimeResult> {
    const started = Date.now()
    if (isCancelled()) return { ok: false, logs: '', error: '任务已取消', durationMs: 0 }
    const kind = script === 'build' ? 'build' : 'typecheck'
    const sourceDir = this.config.appSourceDir(appId)
    await this.assertCapacity('task')
    const image = await this.ensureImage()
    const work = join(this.config.appBuildDir(appId), 'work')
    await rm(work, { recursive: true, force: true })
    await mkdir(join(work, 'node_modules'), { recursive: true })
    await cp(sourceDir, work, {
      recursive: true,
      force: true,
      filter: (src) => {
        const rel = src.slice(sourceDir.length).replace(/^\//, '')
        if (!rel) return true
        const first = rel.split('/')[0]
        return !['node_modules', 'dist', '.git'].includes(first)
      },
    })
    const depsModules = join(this.config.appDepsDir(appId), 'node_modules')
    if (!existsSync(depsModules)) {
      return { ok: false, logs: '', error: '依赖尚未安装，无法构建', durationMs: Date.now() - started }
    }
    const dockerArgs = [
      'run',
      '-d',
      '--name',
      `paimeng-${kind}-${appId}`,
      '--label',
      `${this.docker.projectLabel}=${this.docker.projectName}`,
      '--label',
      `paimeng.app=${appId}`,
      '--label',
      `paimeng.kind=${kind}`,
      '--network',
      'none',
      '--user',
      '1000:1000',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=128',
      `--memory=${this.config.taskMemoryDocker}`,
      `--memory-swap=${this.config.taskMemoryDocker}`,
      '--cpus=1',
      '--tmpfs',
      '/tmp:rw,size=256m',
      '-v',
      `${work}:/app:rw`,
      '-v',
      `${depsModules}:/app/node_modules:ro`,
      '-e',
      'HOME=/tmp',
      '-e',
      'CI=1',
      '-w',
      '/app',
      '--entrypoint',
      'npm',
      image,
      'run',
      script,
      ...extraArgs,
    ]
    return this.runTaskContainer(appId, kind, dockerArgs, timeoutMs, isCancelled)
  }

  async startPreviewContainer(
    appId: number,
    isCancelled: CancelCheck = () => false,
  ): Promise<{
    ok: boolean
    ip?: string
    port?: number
    logs: string
    error?: string
  }> {
    const sourceDir = this.config.appSourceDir(appId)
    const depsModules = join(this.config.appDepsDir(appId), 'node_modules')
    if (!existsSync(join(depsModules, 'vite'))) {
      return { ok: false, logs: '', error: '未安装 vite，无法启动开发预览' }
    }
    await this.assertCapacity('preview')
    const image = await this.ensureImage()
    mkdirSync(join(sourceDir, 'node_modules'), { recursive: true })
    mkdirSync(join(depsModules, '.vite-temp'), { recursive: true })
    const name = `paimeng-app-${appId}`
    await this.docker.removeContainer(name)
    const platformDir = join(__dirname, '../../../docker/runtime')
    const args = [
      'run',
      '-d',
      '--init',
      '--name',
      name,
      '--label',
      `${this.docker.projectLabel}=${this.docker.projectName}`,
      '--label',
      `paimeng.app=${appId}`,
      '--label',
      'paimeng.kind=preview',
      '--network',
      this.config.appNetwork,
      '--user',
      '1000:1000',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=128',
      '--memory=512m',
      '--memory-swap=512m',
      '--cpus=1',
      '--tmpfs',
      '/tmp:rw,size=256m',
      '--tmpfs',
      '/app/node_modules/.vite-temp:rw,size=64m,uid=1000,gid=1000,mode=700',
      '-v',
      `${sourceDir}:/app:ro`,
      '-v',
      `${depsModules}:/app/node_modules:ro`,
      '-v',
      `${platformDir}:/opt/platform:ro`,
      '-e',
      `PREVIEW_PORT=${this.config.previewPort}`,
      '-e',
      `PREVIEW_SCHEME=${this.config.previewScheme}`,
      '-e',
      'HOME=/tmp',
      '-w',
      '/app',
      '--entrypoint',
      'node',
      image,
      '/app/node_modules/vite/bin/vite.js',
      '--config',
      '/opt/platform/vite.config.platform.ts',
      '--host',
      '0.0.0.0',
      '--port',
      '3000',
      '--strictPort',
    ]
    const run = await this.docker.runDetached(args)
    if (!run.id) {
      return { ok: false, logs: '', error: '预览容器启动失败' }
    }
    const deadline = Date.now() + this.config.previewStartTimeoutMs
    let ip: string | null
    while (Date.now() < deadline) {
      if (isCancelled()) {
        await this.docker.removeContainer(name)
        return { ok: false, logs: '', error: '任务已取消' }
      }
      const info = await this.docker.inspectContainer(name)
      if (!info || !info.State.Running) {
        const logs = await this.docker.containerLogs(name, 300)
        await this.docker.removeContainer(name)
        return { ok: false, logs, error: '预览容器进程已退出' }
      }
      ip = info.NetworkSettings.Networks[this.config.appNetwork]?.IPAddress || null
      if (ip && (await this.isPortOpen(ip, 3000))) {
        const httpOk = await this.probeHttp(ip, 3000, '/')
        if (httpOk) {
          const logs = await this.docker.containerLogs(name, 200)
          return { ok: true, ip, port: 3000, logs }
        }
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    const logs = await this.docker.containerLogs(name, 300)
    await this.docker.removeContainer(name)
    return { ok: false, logs, error: `预览启动超时（${Math.round(this.config.previewStartTimeoutMs / 1000)} 秒）` }
  }

  async stopPreviewContainer(appId: number) {
    await this.docker.removeContainer(`paimeng-app-${appId}`)
  }

  async stopTaskContainers(appId: number) {
    await this.docker.removeContainer(`paimeng-install-${appId}`)
    await this.docker.removeContainer(`paimeng-build-${appId}`)
    await this.docker.removeContainer(`paimeng-typecheck-${appId}`)
  }

  async taskLogs(appId: number, kind: 'install' | 'build' | 'typecheck') {
    return this.docker.containerLogs(`paimeng-${kind}-${appId}`, 200)
  }

  async previewContainerLogs(appId: number) {
    return this.docker.containerLogs(`paimeng-app-${appId}`, 200)
  }

  async cleanupBuildDeps(appId: number) {
    await this.stopPreviewContainer(appId)
    await this.stopTaskContainers(appId)
    await rm(this.config.appDepsDir(appId), { recursive: true, force: true })
    await rm(this.config.appBuildDir(appId), { recursive: true, force: true })
  }

  async cleanupAppRuntime(appId: number) {
    await this.stopPreviewContainer(appId)
    await this.stopTaskContainers(appId)
    await rm(this.config.appDepsDir(appId), { recursive: true, force: true })
    await rm(this.config.appBuildDir(appId), { recursive: true, force: true })
    await this.removeSourceDir(appId)
    await rm(join(this.config.taskLogRoot, String(appId)), { recursive: true, force: true })
  }

  async stopAllProjectContainers() {
    const containers = await this.docker.listProjectContainers()
    for (const container of containers) {
      await this.docker.removeContainer(container.ID)
    }
    return containers.length
  }

  async remainingProjectAppIds(): Promise<number[]> {
    const containers = await this.docker.listProjectContainers()
    const ids = new Set<number>()
    for (const container of containers) {
      const match = /(?:^|,)paimeng\.app=(\d+)(?:,|$)/.exec(container.Labels)
      if (match) ids.add(Number(match[1]))
    }
    return [...ids]
  }

  async isPortOpen(ip: string, port: number, timeoutMs = 1000): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = connect({ host: ip, port, timeout: timeoutMs })
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('timeout', () => {
        socket.destroy()
        resolve(false)
      })
      socket.once('error', () => resolve(false))
    })
  }

  async probeHttp(ip: string, port: number, path: string, timeoutMs = 3000): Promise<boolean> {
    return new Promise((resolve) => {
      const req = request({ host: ip, port, path, method: 'GET', timeout: timeoutMs }, (res) => {
        res.resume()
        resolve((res.statusCode ?? 500) < 500)
      })
      req.once('timeout', () => {
        req.destroy()
        resolve(false)
      })
      req.once('error', () => resolve(false))
      req.end()
    })
  }

  async listSourceFiles(appId: number): Promise<string[]> {
    const root = this.config.appSourceDir(appId)
    const out: string[] = []
    const walk = async (dir: string, prefix: string) => {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (out.length >= this.config.maxFileCount) return
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) await walk(join(dir, entry.name), rel)
        else out.push(rel)
      }
    }
    if (existsSync(root)) await walk(root, '')
    return out
  }

  async sourceStats(appId: number): Promise<{ files: number; bytes: number }> {
    const root = this.config.appSourceDir(appId)
    let files = 0
    let bytes = 0
    const walk = async (dir: string) => {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.isFile()) {
          files += 1
          bytes += (await stat(full)).size
        }
      }
    }
    if (existsSync(root)) await walk(root)
    return { files, bytes }
  }
}

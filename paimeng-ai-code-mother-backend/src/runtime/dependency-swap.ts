import { existsSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'

/**
 * 整体切换依赖目录：先把旧 node_modules 移到备份，再挂载新目录。
 * 新目录切换失败时恢复备份，避免安装失败把可用依赖删掉。
 */
export async function swapNodeModules(
  nodeModules: string,
  stagedModules: string,
  backupDir: string,
): Promise<void> {
  let movedOld = false
  try {
    if (existsSync(nodeModules)) {
      await rename(nodeModules, backupDir)
      movedOld = true
    }
    await rename(stagedModules, nodeModules)
  } catch (err) {
    if (movedOld && !existsSync(nodeModules) && existsSync(backupDir)) {
      await rename(backupDir, nodeModules).catch(() => undefined)
    }
    throw err
  }
  if (movedOld) {
    await rm(backupDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

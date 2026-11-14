import { Injectable } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import type { Request } from 'express'
import { ApiException } from '../common/api'
import { DbService } from '../db/db.module'
import { users } from '../db/schema'
import { LoginDto, RegisterDto } from './dto'
import { hashPassword, verifyPassword } from './password'

export interface LoginUserVO {
  id: number
  userAccount: string
  userName: string
  userAvatar: string | null
  userProfile: string | null
  userRole: string
  createTime: string
  updateTime: string
}

export function toLoginUserVO(row: typeof users.$inferSelect): LoginUserVO {
  return {
    id: row.id,
    userAccount: row.userAccount,
    userName: row.userName,
    userAvatar: row.userAvatar,
    userProfile: row.userProfile,
    userRole: row.userRole,
    createTime: row.createdAt.toISOString(),
    updateTime: row.updatedAt.toISOString(),
  }
}

@Injectable()
export class AuthService {
  constructor(private readonly db: DbService) {}

  async register(dto: RegisterDto): Promise<LoginUserVO> {
    const existing = await this.db.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.userAccount, dto.userAccount))
      .limit(1)
    if (existing.length > 0) throw ApiException.conflict('账号已存在')

    const passwordHash = await hashPassword(dto.userPassword)
    let row: typeof users.$inferSelect
    try {
      ;[row] = await this.db.db
        .insert(users)
        .values({
          userAccount: dto.userAccount,
          userPassword: passwordHash,
          userName: dto.userAccount,
        })
        .returning()
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw ApiException.conflict('账号已存在')
      throw err
    }
    return toLoginUserVO(row)
  }

  async login(dto: LoginDto, req: Request): Promise<LoginUserVO> {
    const [row] = await this.db.db
      .select()
      .from(users)
      .where(eq(users.userAccount, dto.userAccount))
      .limit(1)
    if (!row) throw ApiException.badRequest('账号或密码错误')
    const matched = await verifyPassword(dto.userPassword, row.userPassword)
    if (!matched) throw ApiException.badRequest('账号或密码错误')

    await new Promise<void>((resolve, reject) => {
      req.session.regenerate((err) => (err ? reject(err) : resolve()))
    })
    req.session.userId = row.id
    req.session.userAccount = row.userAccount
    await new Promise<void>((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()))
    })
    return toLoginUserVO(row)
  }

  async logout(req: Request): Promise<boolean> {
    if (!req.session) return true
    await new Promise<void>((resolve, reject) => {
      req.session.destroy((err) => (err ? reject(err) : resolve()))
    })
    return true
  }

  async getLoginUser(userId: number): Promise<LoginUserVO> {
    const [row] = await this.db.db.select().from(users).where(eq(users.id, userId)).limit(1)
    if (!row) throw ApiException.unauthorized('登录状态已失效')
    return toLoginUserVO(row)
  }
}

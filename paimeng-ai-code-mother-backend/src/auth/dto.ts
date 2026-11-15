import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'
import { envelope, utcDateTime } from '../common/openapi'

export const registerSchema = z.object({
  userAccount: z.string().trim().min(4, '账号至少 4 个字符').max(64, '账号最多 64 个字符'),
  userPassword: z.string().min(8, '密码至少 8 个字符').max(128, '密码最多 128 个字符'),
  checkPassword: z.string().min(8, '确认密码至少 8 个字符').max(128, '确认密码最多 128 个字符'),
})

export const loginSchema = z.object({
  userAccount: z.string().trim().min(1, '请输入账号').max(64, '账号最多 64 个字符'),
  userPassword: z.string().min(1, '请输入密码').max(128, '密码最多 128 个字符'),
})

export const loginUserVoSchema = z.object({
  id: z.number().int(),
  userAccount: z.string(),
  userName: z.string(),
  userAvatar: z.string().nullable(),
  userProfile: z.string().nullable(),
  userRole: z.string(),
  createTime: utcDateTime,
  updateTime: utcDateTime,
})

export class RegisterDto extends createZodDto(registerSchema) {}
export class LoginDto extends createZodDto(loginSchema) {}
export class LoginUserVO extends createZodDto(loginUserVoSchema) {}
export class BaseResponseLoginUserVO extends createZodDto(envelope(loginUserVoSchema)) {}
export class BaseResponseBoolean extends createZodDto(envelope(z.boolean())) {}

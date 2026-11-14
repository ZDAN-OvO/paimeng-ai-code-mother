import { z } from 'zod'
import { createZodDto } from 'nestjs-zod'

export const registerSchema = z
  .object({
    userAccount: z.string().trim().min(4, '账号至少 4 个字符').max(64, '账号最多 64 个字符'),
    userPassword: z.string().min(8, '密码至少 8 个字符').max(128, '密码最多 128 个字符'),
    checkPassword: z.string().min(8, '确认密码至少 8 个字符').max(128),
  })
  .refine((v) => v.userPassword === v.checkPassword, {
    message: '两次输入的密码不一致',
    path: ['checkPassword'],
  })

export class RegisterDto extends createZodDto(registerSchema) {}

export const loginSchema = z.object({
  userAccount: z.string().trim().min(1, '请输入账号').max(64),
  userPassword: z.string().min(1, '请输入密码').max(128),
})

export class LoginDto extends createZodDto(loginSchema) {}

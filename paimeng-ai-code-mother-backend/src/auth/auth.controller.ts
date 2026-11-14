import { Body, Controller, Get, Post, Req } from '@nestjs/common'
import type { Request } from 'express'
import { ApiException } from '../common/api'
import { Public } from '../common/http'
import { PreviewService } from '../preview/preview.service'
import { AuthService } from './auth.service'
import { LoginDto, RegisterDto } from './dto'

@Controller('user')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly preview: PreviewService,
  ) {}

  @Public()
  @Post('register')
  async register(@Body() dto: RegisterDto, @Req() req: Request) {
    await this.auth.register(dto)
    return this.auth.login({ userAccount: dto.userAccount, userPassword: dto.userPassword }, req)
  }

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, req)
  }

  @Public()
  @Post('logout')
  async logout(@Req() req: Request) {
    const sessionId = req.sessionID
    const result = await this.auth.logout(req)
    if (sessionId) {
      await this.preview.revokeSession(sessionId).catch(() => undefined)
    }
    return result
  }

  @Get('get/login')
  async getLogin(@Req() req: Request) {
    const userId = req.session?.userId
    if (!userId) throw ApiException.unauthorized('未登录')
    return this.auth.getLoginUser(userId)
  }
}

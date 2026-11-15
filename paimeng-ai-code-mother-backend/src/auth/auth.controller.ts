import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { Request } from 'express'
import { ZodValidationException } from 'nestjs-zod'
import type { z } from 'zod'
import { ApiException } from '../common/api'
import { Public } from '../common/http'
import { PreviewService } from '../preview/preview.service'
import { AuthService } from './auth.service'
import { BaseResponseBoolean, BaseResponseLoginUserVO, LoginDto, RegisterDto, loginUserVoSchema } from './dto'

@ApiTags('user')
@Controller('user')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly preview: PreviewService,
  ) {}

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '注册并登录' })
  @ApiOkResponse({ type: BaseResponseLoginUserVO })
  async userRegister(
    @Body() dto: RegisterDto,
    @Req() req: Request,
  ): Promise<z.output<typeof loginUserVoSchema>> {
    if (dto.userPassword !== dto.checkPassword) {
      throw new ZodValidationException({
        issues: [{ code: 'custom', path: ['checkPassword'], message: '两次输入的密码不一致' }],
      })
    }
    await this.auth.register(dto)
    return this.auth.login({ userAccount: dto.userAccount, userPassword: dto.userPassword }, req)
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '登录' })
  @ApiOkResponse({ type: BaseResponseLoginUserVO })
  userLogin(@Body() dto: LoginDto, @Req() req: Request): Promise<z.output<typeof loginUserVoSchema>> {
    return this.auth.login(dto, req)
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '退出登录' })
  @ApiOkResponse({ type: BaseResponseBoolean })
  async userLogout(@Req() req: Request) {
    const sessionId = req.sessionID
    const result = await this.auth.logout(req)
    if (sessionId) {
      await this.preview.revokeSession(sessionId).catch(() => undefined)
    }
    return result
  }

  @Get('get/login')
  @ApiOperation({ summary: '获取当前登录用户' })
  @ApiOkResponse({ type: BaseResponseLoginUserVO })
  async getLoginUser(@Req() req: Request): Promise<z.output<typeof loginUserVoSchema>> {
    const userId = req.session?.userId
    if (!userId) throw ApiException.unauthorized('未登录')
    return this.auth.getLoginUser(userId)
  }
}

import { Body, Controller, Get, Post, Query } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { z } from 'zod'
import { CurrentUser } from '../common/http'
import { AppsService } from './apps.service'
import {
  AddAppDto,
  appListPageSchema,
  appVoSchema,
  AppIdDto,
  AppIdBodyDto,
  BaseResponseAddApp,
  BaseResponseAppListPage,
  BaseResponseAppVO,
  BaseResponseBoolean,
  ListAppQueryDto,
  UpdateAppDto,
} from './dto'

@ApiTags('app')
@Controller()
export class AppsController {
  constructor(private readonly apps: AppsService) {}

  @Post('app/add')
  @ApiOperation({ summary: '创建应用' })
  @ApiOkResponse({ type: BaseResponseAddApp })
  async addApp(@Body() dto: AddAppDto, @CurrentUser() userId: number) {
    return this.apps.createApp(userId, dto.initPrompt)
  }

  @Post('app/my/list/page/vo')
  @ApiOperation({ summary: '分页查询我的应用' })
  @ApiOkResponse({ type: BaseResponseAppListPage })
  async listMyAppVoByPage(@Body() query: ListAppQueryDto, @CurrentUser() userId: number) {
    return this.listPage(query, userId)
  }

  @Get('app/my/list/page')
  @ApiOperation({ summary: '分页查询我的应用（兼容别名）' })
  @ApiOkResponse({ type: BaseResponseAppListPage })
  async listMyAppByPage(@Query() query: ListAppQueryDto, @CurrentUser() userId: number) {
    return this.listPage(query, userId)
  }

  private async listPage(
    query: ListAppQueryDto,
    userId: number,
  ): Promise<z.output<typeof appListPageSchema>> {
    const result = await this.apps.listMyApps(
      userId,
      query.pageNum ?? 1,
      query.pageSize ?? 12,
      query.sortField ?? 'createTime',
      query.sortOrder ?? 'desc',
    )
    return {
      records: result.records,
      total: result.total,
      current: result.current,
      pageSize: result.pageSize,
      pages: Math.ceil(Number(result.total) / result.pageSize) || 0,
    }
  }

  @Get('app/get/vo')
  @ApiOperation({ summary: '获取应用详情' })
  @ApiOkResponse({ type: BaseResponseAppVO })
  async getAppVoById(
    @Query() dto: AppIdDto,
    @CurrentUser() userId: number,
  ): Promise<z.output<typeof appVoSchema>> {
    return this.apps.getAppVO(dto.id, userId)
  }

  @Post('app/update')
  @ApiOperation({ summary: '重命名应用' })
  @ApiOkResponse({ type: BaseResponseBoolean })
  async updateApp(@Body() dto: UpdateAppDto, @CurrentUser() userId: number): Promise<boolean> {
    await this.apps.rename(dto.id, userId, dto.appName)
    return true
  }

  @Post('app/delete')
  @ApiOperation({ summary: '删除应用' })
  @ApiOkResponse({ type: BaseResponseBoolean })
  async deleteApp(@Body() dto: AppIdBodyDto, @CurrentUser() userId: number) {
    await this.apps.requestDelete(dto.id, userId)
    return true
  }
}

import { Body, Controller, Get, Post, Query } from '@nestjs/common'
import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'
import { ApiException } from '../common/api'
import { CurrentUser } from '../common/http'
import { AppsService } from './apps.service'

const addSchema = z.object({ initPrompt: z.string().trim().min(1).max(1000) })
const updateSchema = z.object({
  id: z.number().int().positive(),
  appName: z.string().trim().min(1).max(50),
})
const idSchema = z.object({ id: z.number().int().positive() })
const listSchema = z.object({
  pageNum: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(12),
  sortField: z.enum(['createTime', 'updateTime', 'id', 'appName']).default('createTime'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
})

class AddAppDto extends createZodDto(addSchema) {}
class UpdateAppDto extends createZodDto(updateSchema) {}
class IdDto extends createZodDto(idSchema) {}
class ListQueryDto extends createZodDto(listSchema) {}

@Controller()
export class AppsController {
  constructor(private readonly apps: AppsService) {}

  @Post('app/add')
  async add(@Body() dto: AddAppDto, @CurrentUser() userId: number) {
    return this.apps.createApp(userId, dto.initPrompt)
  }

  @Post('app/my/list/page/vo')
  async listVo(@Body() query: ListQueryDto, @CurrentUser() userId: number) {
    return this.listPage(query, userId)
  }

  @Get('app/my/list/page')
  async list(@Query() query: ListQueryDto, @CurrentUser() userId: number) {
    return this.listPage(query, userId)
  }

  private async listPage(query: ListQueryDto, userId: number) {
    const result = await this.apps.listMyApps(
      userId,
      query.pageNum,
      query.pageSize,
      query.sortField,
      query.sortOrder,
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
  async get(@Query('id') idRaw: string, @CurrentUser() userId: number) {
    const id = Number(idRaw)
    if (!Number.isInteger(id) || id <= 0) throw ApiException.badRequest('应用 ID 无效')
    return this.apps.getAppVO(id, userId)
  }

  @Post('app/update')
  async update(@Body() dto: UpdateAppDto, @CurrentUser() userId: number) {
    await this.apps.rename(dto.id, userId, dto.appName)
    return true
  }

  @Post('app/delete')
  async remove(@Body() dto: IdDto, @CurrentUser() userId: number) {
    await this.apps.requestDelete(dto.id, userId)
    return true
  }
}

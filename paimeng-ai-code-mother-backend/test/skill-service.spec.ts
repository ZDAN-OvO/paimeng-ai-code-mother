import { describe, expect, it } from 'vitest'
import { SkillService } from '../src/skills/skill.service'

describe('skill service', () => {
  it('loads skills from the backend .paimeng/skills directory', async () => {
    const skills = new SkillService()
    await expect(skills.load('static')).resolves.toContain('静态页面交付')
    await expect(skills.load('vue')).resolves.toContain('Vue 3 + Vite 交付')
    await expect(skills.load('react')).resolves.toContain('React + Vite 交付')
    const summaries = await skills.list()
    expect(summaries.map((skill) => skill.name)).toEqual(['react', 'static', 'vue'])
    expect(summaries.find((skill) => skill.name === 'vue')?.description).toContain('Vue 3 + Vite')
    expect(await skills.validateAll()).toEqual([])
  })

  it('returns the body without frontmatter and restricts resources', async () => {
    const skills = new SkillService()
    const body = await skills.load('vue')
    expect(body.startsWith('---')).toBe(false)
    expect(body).toContain('# Vue 3 + Vite 交付')
    await expect(skills.readResource('vue', 'SKILL.md')).rejects.toThrow('只允许')
    await expect(skills.readResource('vue', 'references/missing.md')).rejects.toThrow('不存在')
  })

  it('rejects unknown or traversing skill names', async () => {
    const skills = new SkillService()
    await expect(skills.load('../static')).rejects.toThrow('技能名称非法')
    await expect(skills.load('missing')).rejects.toThrow('不存在')
  })
})

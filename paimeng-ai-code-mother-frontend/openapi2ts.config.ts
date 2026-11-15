import { resolve } from 'node:path'

declare const __dirname: string

export default {
  requestLibPath: "import request from '@/request'",
  schemaPath: resolve(__dirname, '../paimeng-ai-code-mother-backend/openapi.json'),
  serversPath: resolve(__dirname, 'src/api/generated'),
  namespace: 'API',
}

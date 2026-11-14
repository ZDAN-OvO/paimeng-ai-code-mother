/** API 基础地址：默认同源 /api，由 Nginx 或 Vite 代理转发到后端。 */
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api'

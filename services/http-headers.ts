// Unified server request header builder.
//
// 所有服务端 API 调用（JSON、multipart 上传、token 刷新）统一通过此函数构造 headers，
// 确保设备埋点 header 在全链路一致注入。
//
// 合并优先级（后者覆盖前者）：
//   设备 header（默认） → caller extra（可覆盖） → Authorization（最终追加）

import { getDeviceHeaders } from '@/utils/device-info';

export interface BuildServerHeadersOptions {
  /** 调用方自定义 header（如 Content-Type、Accept），优先级高于设备 header */
  extra?: Record<string, string>;
}

/**
 * 构造服务端请求 headers：设备埋点 header + caller header + 可选 Authorization。
 *
 * @param token    Access token；为 null/undefined 时不附加 Authorization
 * @param extra    调用方额外 header（如 Content-Type: application/json）
 *
 * @example
 * // JSON 请求
 * buildServerHeaders(token, { 'Content-Type': 'application/json' })
 *
 * // Multipart 上传（不要传 Content-Type，由底层自动设置 boundary）
 * buildServerHeaders(token)
 *
 * // 匿名请求（token 刷新接口）
 * buildServerHeaders(null, { 'Content-Type': 'application/json' })
 */
export function buildServerHeaders(
  token?: string | null,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    // 1. 设备埋点 header（默认底座）
    ...getDeviceHeaders(),
    // 2. 调用方 header（可覆盖设备 header，如自定义 Content-Type）
    ...extra,
    // 3. Authorization 最后追加，确保不被覆盖
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

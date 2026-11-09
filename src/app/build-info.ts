declare const __SUPERSERVE_SOURCE_HASH__: string

/** 构建时固定的源码指纹；直接运行源码时留空，不能冒充已构建或在线验证。 */
export const buildInfo = Object.freeze({
  sourceHash: typeof __SUPERSERVE_SOURCE_HASH__ === 'string' ? __SUPERSERVE_SOURCE_HASH__ : null,
})

/** 带值类型的键；不包含任何宿主或业务模块依赖。 */
export type Key<V> = string & { readonly __value?: V }
/** 可生成键、并按前缀枚举的同类型记录族。 */
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & { readonly prefix: string }
export const record = <V>(key: string) => key as Key<V>
/** 保持现有键编码，允许调用方指定名称格式。 */
export function family<V, A extends unknown[] = [string]>(prefix: string, format = (...name: A) => name.join(':')): Family<V, A> {
  return Object.assign((...name: A) => `${prefix}${format(...name)}` as Key<V>, { prefix })
}

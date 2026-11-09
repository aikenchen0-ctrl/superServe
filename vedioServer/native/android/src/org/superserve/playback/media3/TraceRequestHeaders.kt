// SPDX-License-Identifier: Apache-2.0
package org.superserve.playback.media3

/**
 * 将服务端返回的观测关联字段映射为Media3请求属性。
 * 该字段不替代traceparent，不参与播放授权，也不写入播放令牌。
 */
object TraceRequestHeaders {
    const val NAME = "x-vs-trace-id"

    fun normalize(value: String?): String? {
        if (value == null || value.length != 32 || value.all { it == '0' }) return null
        if (value.any { it !in '0'..'9' && it !in 'a'..'f' }) return null
        return value
    }

    fun properties(value: String?): Map<String, String> =
        normalize(value)?.let { mapOf(NAME to it) } ?: emptyMap()
}

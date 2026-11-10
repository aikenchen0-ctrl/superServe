// SPDX-License-Identifier: Apache-2.0
package org.superserve.playback.media3

/**
 * 将服务端返回的观测关联字段映射为Media3请求属性。
 * 这些字段不替代traceparent，不参与播放授权，也不写入播放令牌。
 */
object TraceRequestHeaders {
    const val TRACE_ID_NAME = "x-vs-trace-id"
    const val REQUEST_ID_NAME = "x-vs-request-id"

    fun normalize(value: String?): String? {
        if (value == null || value.length != 32 || value.all { it == '0' }) return null
        if (value.any { it !in '0'..'9' && it !in 'a'..'f' }) return null
        return value
    }

    fun normalizeRequestId(value: String?): String? {
        if (value == null || value.isEmpty() || value.length > 64) return null
        if (value.any { it !in 'A'..'Z' && it !in 'a'..'z' && it !in '0'..'9' &&
                it != '_' && it != '-' && it != '.' }) return null
        return value
    }

    fun properties(traceId: String?, requestId: String? = null): Map<String, String> {
        val result = linkedMapOf<String, String>()
        normalize(traceId)?.let { result[TRACE_ID_NAME] = it }
        normalizeRequestId(requestId)?.let { result[REQUEST_ID_NAME] = it }
        return result
    }
}

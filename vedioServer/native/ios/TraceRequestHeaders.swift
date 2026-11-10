// SPDX-License-Identifier: Apache-2.0
import Foundation

/// 将服务端返回的观测关联字段映射到平台HTTP请求。
/// 这些字段不替代traceparent，不参与播放授权，也不写入播放令牌。
public enum TraceRequestHeaders {
    public static let traceIDName = "x-vs-trace-id"
    public static let requestIDName = "x-vs-request-id"

    public static func normalize(_ value: String?) -> String? {
        guard let value, value.count == 32 else { return nil }
        guard value != String(repeating: "0", count: 32) else { return nil }
        guard value.unicodeScalars.allSatisfy({ scalar in
            (scalar.value >= 48 && scalar.value <= 57) ||
                (scalar.value >= 97 && scalar.value <= 102)
        }) else { return nil }
        return value
    }

    public static func normalizeRequestID(_ value: String?) -> String? {
        guard let value, !value.isEmpty, value.count <= 64 else { return nil }
        guard value.unicodeScalars.allSatisfy({ scalar in
            (scalar.value >= 48 && scalar.value <= 57) ||
                (scalar.value >= 65 && scalar.value <= 90) ||
                (scalar.value >= 97 && scalar.value <= 122) ||
                scalar.value == 45 || scalar.value == 46 || scalar.value == 95
        }) else { return nil }
        return value
    }

    public static func properties(
        _ traceID: String?,
        requestID: String? = nil
    ) -> [String: String] {
        var result: [String: String] = [:]
        if let traceID = normalize(traceID) {
            result[traceIDName] = traceID
        }
        if let requestID = normalizeRequestID(requestID) {
            result[requestIDName] = requestID
        }
        return result
    }

    /// 为已有平台请求设置可选观测头；没有合法值时保持原请求。
    public static func request(
        url: URL,
        traceID: String?,
        requestID: String? = nil
    ) -> URLRequest {
        var request = URLRequest(url: url)
        if let value = normalize(traceID) {
            request.setValue(value, forHTTPHeaderField: traceIDName)
        }
        if let value = normalizeRequestID(requestID) {
            request.setValue(value, forHTTPHeaderField: requestIDName)
        }
        return request
    }
}

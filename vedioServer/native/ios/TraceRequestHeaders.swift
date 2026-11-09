// SPDX-License-Identifier: Apache-2.0
import Foundation

/// 将服务端返回的观测关联字段映射到平台HTTP请求。
/// 该字段不替代traceparent，不参与播放授权，也不写入播放令牌。
public enum TraceRequestHeaders {
    public static let name = "x-vs-trace-id"

    public static func normalize(_ value: String?) -> String? {
        guard let value, value.count == 32 else { return nil }
        guard value != String(repeating: "0", count: 32) else { return nil }
        guard value.unicodeScalars.allSatisfy({ scalar in
            (scalar.value >= 48 && scalar.value <= 57) ||
                (scalar.value >= 97 && scalar.value <= 102)
        }) else { return nil }
        return value
    }

    public static func properties(_ value: String?) -> [String: String] {
        guard let traceID = normalize(value) else { return [:] }
        return [name: traceID]
    }

    /// 为已有平台请求设置可选观测头；没有合法观测ID时保持原请求。
    public static func request(url: URL, traceID: String?) -> URLRequest {
        var request = URLRequest(url: url)
        if let value = normalize(traceID) {
            request.setValue(value, forHTTPHeaderField: name)
        }
        return request
    }
}

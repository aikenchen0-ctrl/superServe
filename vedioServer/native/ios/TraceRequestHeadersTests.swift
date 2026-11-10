// SPDX-License-Identifier: Apache-2.0
import XCTest

final class TraceRequestHeadersTests: XCTestCase {
    func testAcceptsCanonicalTraceID() {
        let request = TraceRequestHeaders.request(
            url: URL(string: "https://media.example.test/clip.m3u8")!,
            traceID: "4bf92f3577b34da6a3ce929d0e0e4736"
        )
        XCTAssertEqual(
            request.value(forHTTPHeaderField: "x-vs-trace-id"),
            "4bf92f3577b34da6a3ce929d0e0e4736"
        )
        XCTAssertEqual(
            TraceRequestHeaders.request(
                url: URL(string: "https://media.example.test/clip.m3u8")!,
                traceID: nil,
                requestID: "request-1"
            ).value(forHTTPHeaderField: "x-vs-request-id"),
            "request-1"
        )
    }

    func testRejectsNonCanonicalTraceID() {
        for value in [nil, "4BF92F3577B34DA6A3CE929D0E0E4736", String(repeating: "0", count: 32)] {
            let request = TraceRequestHeaders.request(
                url: URL(string: "https://media.example.test/clip.m3u8")!,
                traceID: value
            )
            XCTAssertNil(request.value(forHTTPHeaderField: "x-vs-trace-id"))
        }
    }

    func testRejectsInvalidRequestID() {
        let request = TraceRequestHeaders.request(
            url: URL(string: "https://media.example.test/clip.m3u8")!,
            traceID: nil,
            requestID: "../subject"
        )
        XCTAssertNil(request.value(forHTTPHeaderField: "x-vs-request-id"))
    }
}

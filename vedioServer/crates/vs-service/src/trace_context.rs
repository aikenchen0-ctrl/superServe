use axum::http::HeaderMap;
use vs_core::joint_workload::TraceContext;

const MAX_TRACESTATE_BYTES: usize = 8192;
const MAX_TRACEPARENT_BYTES: usize = 8192;

#[derive(Debug, Clone)]
pub(crate) struct TracePropagation {
    traceparent: String,
    context: Option<TraceContext>,
    tracestate: Option<String>,
}

impl TracePropagation {
    pub(crate) fn from_headers(headers: &HeaderMap) -> Option<Self> {
        let mut parents = headers.get_all("traceparent").iter();
        let parent = parents.next()?.to_str().ok()?;
        if parents.next().is_some() {
            return None;
        }
        if parent.len() > MAX_TRACEPARENT_BYTES {
            return None;
        }
        // 服务不创建跨度：追踪头原样透传，本地关联只解析当前工作负载模型支持的 v00。
        let context = if parent.starts_with("00-") {
            TraceContext::from_traceparent(parent).ok()
        } else {
            None
        };
        let tracestate = pass_through_tracestate(headers)?;
        Some(Self {
            traceparent: parent.to_owned(),
            context,
            tracestate,
        })
    }

    pub(crate) fn traceparent(&self) -> &str {
        &self.traceparent
    }

    pub(crate) fn trace_id(&self) -> Option<&str> {
        self.context
            .as_ref()
            .map(|context| context.trace_id.as_str())
    }

    pub(crate) fn tracestate(&self) -> Option<&str> {
        self.tracestate.as_deref()
    }
}

pub(crate) fn trace_id_from_headers(headers: &HeaderMap) -> Option<String> {
    if headers.contains_key("traceparent") {
        return TracePropagation::from_headers(headers)
            .and_then(|context| context.trace_id().map(str::to_owned));
    }
    headers
        .get("x-vs-trace-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| {
            value.len() == 32
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                && !value.bytes().all(|byte| byte == b'0')
        })
        .map(str::to_owned)
}

pub(crate) fn request_id_from_headers(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-vs-request-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| vs_core::valid_id(value))
        .map(str::to_owned)
}

fn pass_through_tracestate(headers: &HeaderMap) -> Option<Option<String>> {
    let mut values = headers.get_all("tracestate").iter();
    let Some(first) = values.next() else {
        return Some(None);
    };

    let mut combined = String::new();
    for (index, value) in std::iter::once(first).chain(values).enumerate() {
        let value = value.to_str().ok()?;
        let next_len = combined
            .len()
            .saturating_add(usize::from(index > 0))
            .saturating_add(value.len());
        if next_len > MAX_TRACESTATE_BYTES {
            return None;
        }
        if index > 0 {
            combined.push(',');
        }
        combined.push_str(value);
    }
    Some(Some(combined))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    const PARENT: &str = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    fn make_headers(parent: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("traceparent", HeaderValue::from_str(parent).unwrap());
        headers
    }

    #[test]
    fn combines_multiple_fields_in_order_and_preserves_valid_state() {
        let mut headers = make_headers(PARENT);
        headers.append("tracestate", HeaderValue::from_static("vendor-a=value-a"));
        headers.append(
            "tracestate",
            HeaderValue::from_static("tenant@system=value-b"),
        );

        let propagation = TracePropagation::from_headers(&headers).unwrap();
        assert_eq!(
            propagation.tracestate(),
            Some("vendor-a=value-a,tenant@system=value-b")
        );

        let mut empty_headers = make_headers(PARENT);
        empty_headers.insert(
            "tracestate",
            HeaderValue::from_static(", tenant@system=value-b"),
        );
        assert_eq!(
            TracePropagation::from_headers(&empty_headers)
                .unwrap()
                .tracestate(),
            Some(", tenant@system=value-b")
        );
    }

    #[test]
    fn state_is_forwarded_verbatim_without_local_parsing() {
        for value in ["Vendor=value", "vendor=value, vendor=value2", "vendor="] {
            let mut headers = make_headers(PARENT);
            headers.insert("tracestate", HeaderValue::from_str(value).unwrap());
            let propagation = TracePropagation::from_headers(&headers).unwrap();
            assert_eq!(propagation.tracestate(), Some(value));
            assert_eq!(propagation.traceparent(), PARENT);
        }

        let mut headers = make_headers(PARENT);
        headers.insert("tracestate", HeaderValue::from_static("vendor=value \t"));
        assert_eq!(
            TracePropagation::from_headers(&headers)
                .unwrap()
                .tracestate(),
            Some("vendor=value \t")
        );
    }

    #[test]
    fn state_over_budget_rejects_the_entire_context() {
        let mut headers = make_headers(PARENT);
        let at_limit = "x".repeat(MAX_TRACESTATE_BYTES);
        headers.insert("tracestate", HeaderValue::from_str(&at_limit).unwrap());
        assert_eq!(
            TracePropagation::from_headers(&headers)
                .unwrap()
                .tracestate()
                .map(str::len),
            Some(MAX_TRACESTATE_BYTES)
        );

        let oversized = "x".repeat(MAX_TRACESTATE_BYTES + 1);
        headers.insert("tracestate", HeaderValue::from_str(&oversized).unwrap());
        assert!(TracePropagation::from_headers(&headers).is_none());
    }

    #[test]
    fn malformed_parent_is_forwarded_but_duplicate_parent_is_rejected() {
        let mut malformed_parent = make_headers("00-malformed");
        malformed_parent.insert("tracestate", HeaderValue::from_static("vendor=value"));
        let propagation = TracePropagation::from_headers(&malformed_parent).unwrap();
        assert_eq!(propagation.traceparent(), "00-malformed");
        assert_eq!(propagation.tracestate(), Some("vendor=value"));
        assert_eq!(propagation.trace_id(), None);

        let mut headers = make_headers(PARENT);
        headers.append("traceparent", HeaderValue::from_static(PARENT));
        headers.insert("tracestate", HeaderValue::from_static("vendor=value"));
        assert!(TracePropagation::from_headers(&headers).is_none());
    }

    #[test]
    fn future_parent_version_is_forwarded_opaque_without_local_trace_attribution() {
        let parent = "future-vendor-context";
        let mut headers = make_headers(parent);
        headers.append("tracestate", HeaderValue::from_static("vendor=value"));
        headers.append("tracestate", HeaderValue::from_static("tenant=blue"));

        let propagation = TracePropagation::from_headers(&headers).unwrap();
        assert_eq!(propagation.traceparent(), parent);
        assert_eq!(propagation.tracestate(), Some("vendor=value,tenant=blue"));
        assert_eq!(propagation.trace_id(), None);
        assert_eq!(trace_id_from_headers(&headers), None);

        headers.insert(
            "x-vs-trace-id",
            HeaderValue::from_static("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        );
        assert_eq!(trace_id_from_headers(&headers), None);
    }

    #[test]
    fn request_observation_id_is_bounded_and_separate_from_trace_authority() {
        let mut headers = make_headers(PARENT);
        headers.insert("x-vs-request-id", HeaderValue::from_static("request-1"));
        assert_eq!(
            request_id_from_headers(&headers).as_deref(),
            Some("request-1")
        );

        headers.insert("x-vs-request-id", HeaderValue::from_static("../subject"));
        assert_eq!(request_id_from_headers(&headers), None);
        assert_eq!(
            trace_id_from_headers(&headers).as_deref(),
            Some("4bf92f3577b34da6a3ce929d0e0e4736")
        );
    }

    #[test]
    fn unknown_parent_versions_are_bounded_and_forwarded_without_local_attribution() {
        let too_long_parent = format!(
            "future-vendor-context-{}",
            "x".repeat(MAX_TRACEPARENT_BYTES)
        );
        let headers = make_headers(&too_long_parent);
        assert!(TracePropagation::from_headers(&headers).is_none());

        let headers = make_headers("01-future-format");
        let propagation = TracePropagation::from_headers(&headers).unwrap();
        assert_eq!(propagation.traceparent(), "01-future-format");
        assert_eq!(propagation.trace_id(), None);

        let mut headers = make_headers("future-vendor-context");
        headers.insert(
            "tracestate",
            HeaderValue::from_str(&"x".repeat(MAX_TRACESTATE_BYTES + 1)).unwrap(),
        );
        assert!(TracePropagation::from_headers(&headers).is_none());
    }
}

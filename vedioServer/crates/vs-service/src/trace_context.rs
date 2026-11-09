use std::collections::HashSet;

use axum::http::HeaderMap;
use vs_core::joint_workload::TraceContext;

const MAX_TRACESTATE_BYTES: usize = 512;
const MAX_TRACESTATE_MEMBERS: usize = 32;
const MAX_TRACESTATE_INPUT_BYTES: usize = 8192;

#[derive(Debug, Clone)]
pub(crate) struct TracePropagation {
    context: TraceContext,
    tracestate: Option<String>,
}

impl TracePropagation {
    pub(crate) fn from_headers(headers: &HeaderMap) -> Option<Self> {
        let mut parents = headers.get_all("traceparent").iter();
        let parent = parents.next()?.to_str().ok()?;
        if parents.next().is_some() {
            return None;
        }
        let context = TraceContext::from_traceparent(parent).ok()?;
        Some(Self {
            context,
            tracestate: parse_tracestate(headers),
        })
    }

    pub(crate) fn traceparent(&self) -> Option<String> {
        self.context.to_traceparent()
    }

    pub(crate) fn trace_id(&self) -> &str {
        &self.context.trace_id
    }

    pub(crate) fn tracestate(&self) -> Option<&str> {
        self.tracestate.as_deref()
    }
}

fn parse_tracestate(headers: &HeaderMap) -> Option<String> {
    let values: Vec<_> = headers.get_all("tracestate").iter().collect();
    if values.is_empty() {
        return None;
    }

    let mut combined = String::new();
    for (index, value) in values.into_iter().enumerate() {
        let value = value.to_str().ok()?;
        if index > 0 {
            combined.push(',');
        }
        combined.push_str(value);
        if combined.len() > MAX_TRACESTATE_INPUT_BYTES {
            return None;
        }
    }
    if combined.is_empty() {
        return None;
    }

    let mut members = Vec::new();
    let mut keys = HashSet::new();
    for member in combined.split(',') {
        let member = member.trim_matches([' ', '\t']);
        if member.is_empty() {
            members.push(String::new());
            continue;
        }

        let (key, value) = member.split_once('=')?;
        if !valid_key(key) || !valid_value(value) || !keys.insert(key) {
            return None;
        }
        members.push(member.to_owned());
    }

    if members.iter().all(String::is_empty) {
        return None;
    }
    if members.len() <= MAX_TRACESTATE_MEMBERS
        && combined.len() <= MAX_TRACESTATE_BYTES
        && members.iter().all(|member| member.len() <= 128)
    {
        return Some(combined);
    }

    members.retain(|member| !member.is_empty() && member.len() <= 128);
    while members.len() > MAX_TRACESTATE_MEMBERS || joined_len(&members) > MAX_TRACESTATE_BYTES {
        members.pop()?;
    }

    (!members.is_empty()).then(|| members.join(","))
}

fn valid_key(key: &str) -> bool {
    if key.is_empty() || key.len() > 256 || !key.is_ascii() {
        return false;
    }
    let mut bytes = key.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    (first.is_ascii_lowercase() || first.is_ascii_digit())
        && bytes.all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'_' | b'-' | b'*' | b'/' | b'@')
        })
}

fn valid_value(value: &str) -> bool {
    if value.is_empty() || value.len() > 256 {
        return false;
    }
    value
        .bytes()
        .all(|byte| (0x20..=0x7e).contains(&byte) && !matches!(byte, b',' | b'='))
        && !value.ends_with(' ')
}

fn joined_len(members: &[String]) -> usize {
    members.iter().map(String::len).sum::<usize>() + members.len().saturating_sub(1)
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
    fn invalid_state_is_dropped_without_discarding_parent() {
        for value in [
            "Vendor=value",
            "vendor=value, vendor=value2",
            "vendor=",
            "vendor=value=extra",
        ] {
            let mut headers = make_headers(PARENT);
            headers.insert("tracestate", HeaderValue::from_str(value).unwrap());
            let propagation = TracePropagation::from_headers(&headers).unwrap();
            assert!(propagation.tracestate().is_none(), "{value}");
            assert_eq!(propagation.traceparent().as_deref(), Some(PARENT));
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
    fn state_limits_truncate_only_complete_members_from_the_right() {
        let long = format!("long={}", "x".repeat(129));
        let short = "vendor=value";
        let mut headers = make_headers(PARENT);
        headers.insert(
            "tracestate",
            HeaderValue::from_str(&format!("{long},{short}")).unwrap(),
        );
        assert_eq!(
            TracePropagation::from_headers(&headers)
                .unwrap()
                .tracestate(),
            Some(short)
        );

        let many = (0..MAX_TRACESTATE_MEMBERS + 1)
            .map(|index| format!("vendor{index}=x"))
            .collect::<Vec<_>>()
            .join(",");
        headers.insert("tracestate", HeaderValue::from_str(&many).unwrap());
        let state = TracePropagation::from_headers(&headers)
            .unwrap()
            .tracestate()
            .unwrap()
            .to_owned();
        assert_eq!(state.split(',').count(), MAX_TRACESTATE_MEMBERS);
        assert!(!state.contains("vendor32="));
        assert_eq!(state.split(',').next(), Some("vendor0=x"));

        let oversized = format!("vendor={}", "x".repeat(MAX_TRACESTATE_INPUT_BYTES));
        headers.insert("tracestate", HeaderValue::from_str(&oversized).unwrap());
        let propagation = TracePropagation::from_headers(&headers).unwrap();
        assert!(propagation.tracestate().is_none());
        assert_eq!(propagation.traceparent().as_deref(), Some(PARENT));
    }

    #[test]
    fn invalid_or_duplicate_parent_prevents_state_propagation() {
        let mut invalid_parent = make_headers("invalid");
        invalid_parent.insert("tracestate", HeaderValue::from_static("vendor=value"));
        assert!(TracePropagation::from_headers(&invalid_parent).is_none());

        let mut headers = make_headers(PARENT);
        headers.append("traceparent", HeaderValue::from_static(PARENT));
        headers.insert("tracestate", HeaderValue::from_static("vendor=value"));
        assert!(TracePropagation::from_headers(&headers).is_none());
    }
}

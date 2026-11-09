// SPDX-License-Identifier: MIT
// 复用固定atm0s的RemoteIce命令边界和str0m的Candidate解析/注入接口。
// Copyright (c) 2023 8xFF
// 片段预算、代次校验和严格字段范围为本项目适配，不复制上游宽松的逐条忽略逻辑。
use std::collections::HashSet;

use str0m::{Candidate, change::SdpOffer, net::Protocol};

use crate::RelayError;

pub const MAX_FRAGMENT_BYTES: usize = 8192;
pub const MAX_REMOTE_CANDIDATES: usize = 64;

pub struct IceFragment {
    sections: Vec<Section>,
}

struct Section {
    kind: String,
    mid: String,
    ufrag: String,
    password: String,
    candidates: Vec<Candidate>,
}

struct Identity {
    kind: String,
    mid: String,
    ufrag: String,
    password: String,
}

pub(crate) struct RemoteIce {
    identities: Vec<Identity>,
    seen: HashSet<String>,
}

fn credential(value: &str, minimum: usize) -> bool {
    (minimum..=256).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"+/".contains(&byte))
}

fn unresolved_mdns(line: &str) -> bool {
    let mut fields: Vec<_> = line[2..].split_ascii_whitespace().collect();
    let Some(address) = fields.get(4) else {
        return false;
    };
    if address.len() > 253
        || !address.to_ascii_lowercase().ends_with(".local")
        || address.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return false;
    }
    // 只替换不可解析地址来复用候选语法校验；不会注入这个替代地址，也不执行DNS。
    fields[4] = "127.0.0.1";
    Candidate::from_sdp_string(&fields.join(" ")).is_ok()
}

impl IceFragment {
    /// 只处理ICE片段的外层分节；候选语法仍交给固定str0m解析。
    pub fn parse(text: &str) -> Result<Self, RelayError> {
        if text.is_empty() || text.len() > MAX_FRAGMENT_BYTES || !text.is_ascii() {
            return Err(RelayError::Invalid);
        }
        let mut sections = Vec::new();
        let (mut ufrag, mut password) = (None, None);
        let mut candidate_count = 0;
        let mut end_markers = HashSet::new();
        for line in text.lines() {
            if line.bytes().any(|byte| byte.is_ascii_control()) {
                return Err(RelayError::Invalid);
            }
            if line.starts_with("m=") {
                // 完整SDP解析器要求片段本来不携带的方向和rtpmap；这里只接受既有RTP范围的外层标记。
                let fields: Vec<_> = line.split_ascii_whitespace().collect();
                if !(4..=35).contains(&fields.len())
                    || !matches!(fields[0], "m=video" | "m=audio")
                    || fields[1].parse::<u16>().is_err()
                    || fields[2] != "UDP/TLS/RTP/SAVPF"
                    || fields[3..]
                        .iter()
                        .any(|field| !field.parse::<u8>().is_ok_and(|pt| pt <= 127))
                    || sections.len() >= 2
                {
                    return Err(RelayError::Invalid);
                }
                sections.push(Section {
                    kind: fields[0][2..].into(),
                    mid: String::new(),
                    ufrag: String::new(),
                    password: String::new(),
                    candidates: Vec::new(),
                });
            } else if let Some(value) = line.strip_prefix("a=ice-ufrag:") {
                if !credential(value, 4) {
                    return Err(RelayError::Invalid);
                }
                if let Some(section) = sections.last_mut() {
                    if !section.ufrag.is_empty() {
                        return Err(RelayError::Invalid);
                    }
                    section.ufrag = value.into();
                } else if ufrag.replace(value.to_string()).is_some() {
                    return Err(RelayError::Invalid);
                }
            } else if let Some(value) = line.strip_prefix("a=ice-pwd:") {
                if !credential(value, 22) {
                    return Err(RelayError::Invalid);
                }
                if let Some(section) = sections.last_mut() {
                    if !section.password.is_empty() {
                        return Err(RelayError::Invalid);
                    }
                    section.password = value.into();
                } else if password.replace(value.to_string()).is_some() {
                    return Err(RelayError::Invalid);
                }
            } else if let Some(value) = line.strip_prefix("a=mid:") {
                let section = sections.last_mut().ok_or(RelayError::Invalid)?;
                if !section.mid.is_empty() || !vs_core::valid_id(value) {
                    return Err(RelayError::Invalid);
                }
                section.mid = value.into();
            } else if line.starts_with("a=candidate:") {
                let section_index = sections.len();
                let section = sections.last_mut().ok_or(RelayError::Invalid)?;
                if end_markers.contains(&section_index) {
                    return Err(RelayError::Invalid);
                }
                candidate_count += 1;
                if candidate_count > 32 {
                    return Err(RelayError::Invalid);
                }
                let candidate = match Candidate::from_sdp_string(&line[2..]) {
                    Ok(candidate) => candidate,
                    // RFC9725要求忽略不能解析地址的候选，不能让mDNS破坏整批合法更新。
                    Err(_) if unresolved_mdns(line) => continue,
                    Err(_) => return Err(RelayError::Invalid),
                };
                if candidate.proto() != Protocol::Udp {
                    continue;
                }
                // 地址解析不授予发包权限；工作器另按回环或固定私网对端策略收发，不做DNS。
                if candidate.addr().port() == 0 {
                    return Err(RelayError::Invalid);
                }
                section.candidates.push(candidate);
            } else if line == "a=end-of-candidates" {
                if sections.is_empty() || !end_markers.insert(sections.len()) {
                    return Err(RelayError::Invalid);
                }
            } else {
                return Err(RelayError::Invalid);
            }
        }
        let mut mids = HashSet::new();
        for section in &mut sections {
            if section.ufrag.is_empty() {
                section.ufrag = ufrag.clone().unwrap_or_default();
            }
            if section.password.is_empty() {
                section.password = password.clone().unwrap_or_default();
            }
            if section.mid.is_empty()
                || !mids.insert(section.mid.clone())
                || !credential(&section.ufrag, 4)
                || !credential(&section.password, 22)
                || section.candidates.iter().any(|candidate| {
                    candidate
                        .ufrag()
                        .is_some_and(|value| value != section.ufrag)
                })
            {
                return Err(RelayError::Invalid);
            }
        }
        if sections.is_empty() || (candidate_count == 0 && end_markers.is_empty()) {
            return Err(RelayError::Invalid);
        }
        Ok(Self { sections })
    }
}

impl RemoteIce {
    #[cfg(test)]
    pub(crate) fn seen_count_for_test(&self) -> usize {
        self.seen.len()
    }

    pub(crate) fn from_offer(offer: &SdpOffer) -> Result<Self, RelayError> {
        let fallback = offer.session.ice_creds();
        let mut identities = Vec::new();
        let mut seen = HashSet::new();
        for media in &offer.media_lines {
            let credentials = media
                .ice_creds()
                .or_else(|| fallback.clone())
                .ok_or(RelayError::Invalid)?;
            identities.push(Identity {
                kind: media.typ.to_string(),
                mid: media.mid().to_string(),
                ufrag: credentials.ufrag,
                password: credentials.pass,
            });
            seen.extend(media.ice_candidates().map(Candidate::to_sdp_string));
        }
        if seen.len() > MAX_REMOTE_CANDIDATES {
            return Err(RelayError::Busy);
        }
        Ok(Self { identities, seen })
    }

    pub(crate) fn prepare(
        &self,
        fragment: IceFragment,
    ) -> Result<Vec<(String, Candidate)>, RelayError> {
        let mut pending = Vec::new();
        let mut keys = HashSet::new();
        // 全部检查通过再注入，保证校验类拒绝不产生部分候选更新。
        for section in fragment.sections {
            let identity = self
                .identities
                .iter()
                .find(|identity| identity.mid == section.mid)
                .ok_or(RelayError::Invalid)?;
            if identity.kind != section.kind {
                return Err(RelayError::Invalid);
            }
            if identity.ufrag != section.ufrag || identity.password != section.password {
                return Err(RelayError::IceRestartUnsupported);
            }
            for candidate in section.candidates {
                let key = candidate.to_sdp_string();
                if !self.seen.contains(&key) && keys.insert(key.clone()) {
                    pending.push((key, candidate));
                }
            }
        }
        if self.seen.len() + pending.len() > MAX_REMOTE_CANDIDATES {
            return Err(RelayError::Busy);
        }
        Ok(pending)
    }

    pub(crate) fn remember(&mut self, key: String) {
        self.seen.insert(key);
    }

    #[cfg(test)]
    fn apply(&mut self, fragment: IceFragment, rtc: &mut str0m::Rtc) -> Result<usize, RelayError> {
        let pending = self.prepare(fragment)?;
        let added = pending.len();
        for (key, candidate) in pending {
            rtc.add_remote_candidate(candidate);
            while !matches!(
                rtc.poll_output().map_err(|_| RelayError::Invalid)?,
                str0m::Output::Timeout(_)
            ) {}
            self.remember(key);
        }
        Ok(added)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::Arc, time::Instant};

    fn fragment(candidates: &str) -> String {
        format!(
            "a=ice-ufrag:abcd\r\na=ice-pwd:abcdefghijklmnopqrstuv\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n{candidates}"
        )
    }

    fn remote() -> RemoteIce {
        RemoteIce {
            identities: vec![Identity {
                kind: "video".into(),
                mid: "0".into(),
                ufrag: "abcd".into(),
                password: "abcdefghijklmnopqrstuv".into(),
            }],
            seen: HashSet::new(),
        }
    }

    fn rtc() -> str0m::Rtc {
        str0m::Rtc::builder()
            .set_crypto_provider(Arc::new(str0m::crypto::from_feature_flags()))
            .build(Instant::now())
    }

    fn candidate(port: usize) -> String {
        format!("a=candidate:1 1 UDP 2130706431 127.0.0.1 {port} typ host\r\n")
    }

    #[test]
    fn duplicate_updates_and_end_markers_do_not_grow_remote_state() {
        let mut remote = remote();
        let mut rtc = rtc();
        let text = fragment(&(candidate(30000) + &candidate(30000) + "a=end-of-candidates\r\n"));
        assert_eq!(
            remote
                .apply(IceFragment::parse(&text).unwrap(), &mut rtc)
                .unwrap(),
            1
        );
        assert_eq!(
            remote
                .apply(IceFragment::parse(&text).unwrap(), &mut rtc)
                .unwrap(),
            0
        );
        assert_eq!(
            remote
                .apply(
                    IceFragment::parse(&fragment("a=end-of-candidates\r\n")).unwrap(),
                    &mut rtc
                )
                .unwrap(),
            0
        );
        assert_eq!(remote.seen.len(), 1);
    }

    #[test]
    fn whole_fragment_validation_precedes_candidate_mutation() {
        let mut remote = remote();
        let mut rtc = rtc();
        for replacement in ["unknown-mid", "restart"] {
            let text = if replacement == "unknown-mid" {
                format!(
                    "{}m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:1\r\na=candidate:1 1 UDP 2130706431 127.0.0.1 30001 typ host\r\n",
                    fragment(&candidate(30000))
                )
            } else {
                fragment(&candidate(30000)).replace("a=ice-ufrag:abcd", "a=ice-ufrag:efgh")
            };
            assert!(
                remote
                    .apply(IceFragment::parse(&text).unwrap(), &mut rtc)
                    .is_err()
            );
            assert!(remote.seen.is_empty());
        }
    }

    #[test]
    fn remote_capacity_is_bounded_and_full_state_accepts_idempotent_retries() {
        let mut remote = remote();
        let mut rtc = rtc();
        for offset in [0, 32] {
            let text = (offset..offset + 32)
                .map(|i| candidate(30000 + i))
                .collect::<String>();
            assert_eq!(
                remote
                    .apply(IceFragment::parse(&fragment(&text)).unwrap(), &mut rtc)
                    .unwrap(),
                32
            );
        }
        assert_eq!(remote.seen.len(), 64);
        assert!(matches!(
            remote.apply(
                IceFragment::parse(&fragment(&candidate(30100))).unwrap(),
                &mut rtc
            ),
            Err(RelayError::Busy)
        ));
        assert_eq!(remote.seen.len(), 64);
        assert_eq!(
            remote
                .apply(
                    IceFragment::parse(&fragment(&candidate(30000))).unwrap(),
                    &mut rtc
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn budgets_unknown_fields_and_nonudp_or_ambiguous_candidates_fail_closed() {
        for text in [
            String::new(),
            fragment(&candidate(30000)).replace("a=mid:0", ""),
            fragment(&candidate(30000)).replace("a=mid:0", "a=mid:0\r\na=mid:0"),
            fragment(&candidate(30000))
                .replace("a=ice-ufrag:abcd", "a=ice-ufrag:abcd\r\na=ice-ufrag:efgh"),
            fragment(&candidate(30000)).replace("UDP", "TCP"),
            fragment(&candidate(0)),
            fragment(&candidate(30000)).replace("typ host", "typ host ufrag wrong"),
            fragment("a=candidate:invalid\r\n"),
            fragment("a=end-of-candidates\r\na=end-of-candidates\r\n"),
            fragment(&format!("a=end-of-candidates\r\n{}", candidate(30000))),
            fragment("a=sendonly\r\n"),
            fragment("a=fingerprint:sha-256 abcd\r\n"),
            fragment("v=0\r\n"),
            fragment("a=mid:非法\r\n"),
            fragment("a=candidate:\0\r\n"),
            fragment(&(0..33).map(|i| candidate(30000 + i)).collect::<String>()),
            "a".repeat(MAX_FRAGMENT_BYTES + 1),
        ] {
            assert!(IceFragment::parse(&text).is_err(), "片段边界未拒绝");
        }
    }

    #[test]
    fn session_and_media_credentials_parse_without_exposing_secrets() {
        let mut remote = remote();
        let mut rtc = rtc();
        let text = format!(
            "m=video 9 UDP/TLS/RTP/SAVPF 96\na=mid:0\na=ice-ufrag:abcd\na=ice-pwd:abcdefghijklmnopqrstuv\n{}",
            candidate(30000)
        );
        assert_eq!(
            remote
                .apply(IceFragment::parse(&text).unwrap(), &mut rtc)
                .unwrap(),
            1
        );
    }

    #[test]
    fn unresolved_mdns_and_supported_syntax_for_unsupported_transport_are_silently_discarded() {
        let mut remote = remote();
        let mut rtc = rtc();
        let unsupported = candidate(30000).replace("127.0.0.1", "peer.local")
            + &candidate(30001)
                .replace("UDP", "TCP")
                .replace("typ host", "typ host tcptype passive");
        assert_eq!(
            remote
                .apply(
                    IceFragment::parse(&fragment(&unsupported)).unwrap(),
                    &mut rtc
                )
                .unwrap(),
            0
        );
        assert_eq!(remote.seen.len(), 0);
        let mixed = unsupported + &candidate(30002);
        assert_eq!(
            remote
                .apply(IceFragment::parse(&fragment(&mixed)).unwrap(), &mut rtc)
                .unwrap(),
            1
        );
        assert_eq!(remote.seen.len(), 1);
    }
}

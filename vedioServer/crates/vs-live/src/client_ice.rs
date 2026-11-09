// SPDX-License-Identifier: MIT
// 局部迁移MediaMTX的LinkHeader凭据转义和端点发现机制；来源见mediamtx-NOTICE.txt。
// Copyright (c) 2019 aler9
use std::{
    collections::BTreeSet,
    io,
    net::SocketAddrV4,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::http::{HeaderMap, HeaderValue, header};
use serde::Deserialize;
use vs_live::RelayError;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClientIceConfig {
    pub expires_unix_seconds: u64,
    pub servers: Vec<IceServer>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IceServer {
    pub url: String,
    pub username: String,
    pub credential: String,
}

pub struct ClientIce {
    expires: u64,
    deadline: Instant,
    links: Vec<HeaderValue>,
}

fn epoch() -> io::Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_secs())
        .map_err(|_| io::Error::other("ICE配置授权时钟不可用"))
}

fn credential(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_graphic())
}

fn quote(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

impl ClientIce {
    pub fn load(config: ClientIceConfig) -> io::Result<Self> {
        Self::at(config, epoch()?, Instant::now())
    }

    fn at(config: ClientIceConfig, now: u64, instant: Instant) -> io::Result<Self> {
        let invalid =
            || io::Error::other("ICE发现须为有限私网UDP TURN服务器、固定凭据及至多300秒授权");
        if !(1..=4).contains(&config.servers.len())
            || config.expires_unix_seconds <= now
            || config.expires_unix_seconds.saturating_sub(now) > 300
        {
            return Err(invalid());
        }
        let mut urls = BTreeSet::new();
        let mut links = Vec::new();
        for server in config.servers {
            let address: SocketAddrV4 = server
                .url
                .strip_prefix("turn:")
                .and_then(|url| url.strip_suffix("?transport=udp"))
                .and_then(|address| address.parse().ok())
                .ok_or_else(invalid)?;
            if !(address.ip().is_private() || address.ip().is_loopback())
                || address.port() < 1024
                || server.url != format!("turn:{address}?transport=udp")
                || !urls.insert(server.url.clone())
                || !credential(&server.username, 1, 64)
                || !credential(&server.credential, 32, 128)
            {
                return Err(invalid());
            }
            let mut link = HeaderValue::from_str(&format!(
                    "<{}>; rel=\"ice-server\"; username=\"{}\"; credential=\"{}\"; credential-type=\"password\"",
                    server.url, quote(&server.username), quote(&server.credential)
                ))
                .map_err(|_| invalid())?;
            link.set_sensitive(true);
            links.push(link);
        }
        Ok(Self {
            expires: config.expires_unix_seconds,
            deadline: instant + Duration::from_secs(config.expires_unix_seconds - now),
            links,
        })
    }

    pub fn check(&self) -> Result<(), RelayError> {
        self.check_at(
            epoch().map_err(|_| RelayError::Unavailable)?,
            Instant::now(),
        )
    }

    fn check_at(&self, now: u64, instant: Instant) -> Result<(), RelayError> {
        // 单调期限不会因墙钟回退延长；墙钟提前到期同样停止发现。
        if now >= self.expires || instant >= self.deadline {
            return Err(RelayError::Unavailable);
        }
        Ok(())
    }

    pub fn append(&self, headers: &mut HeaderMap, grant_expires: u64) {
        for value in &self.links {
            headers.append(header::LINK, value.clone());
        }
        headers.insert("x-vs-ice-expires", self.expires.min(grant_expires).into());
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> ClientIceConfig {
        ClientIceConfig {
            expires_unix_seconds: 130,
            servers: vec![IceServer {
                url: "turn:127.0.0.1:3478?transport=udp".into(),
                username: "user".into(),
                credential: "test-password-with-at-least-32-bytes".into(),
            }],
        }
    }

    #[test]
    fn credentials_are_quoted_and_multiple_links_do_not_merge_secret_delimiters() {
        let mut config = fixture();
        config.servers[0].username = "u\",<x>\\end".into();
        config.servers[0].credential = "long-password-with-32-bytes-\"\\;<x>".into();
        config.servers.push(IceServer {
            url: "turn:10.1.2.3:3479?transport=udp".into(),
            username: "other".into(),
            credential: "test-password-with-at-least-32-bytes".into(),
        });
        let ice = ClientIce::at(config, 100, Instant::now()).unwrap();
        let mut headers = HeaderMap::new();
        ice.append(&mut headers, 125);
        let links: Vec<_> = headers.get_all(header::LINK).iter().collect();
        assert_eq!(links.len(), 2);
        assert_eq!(
            links[0],
            "<turn:127.0.0.1:3478?transport=udp>; rel=\"ice-server\"; username=\"u\\\",<x>\\\\end\"; credential=\"long-password-with-32-bytes-\\\"\\\\;<x>\"; credential-type=\"password\""
        );
        assert!(links.iter().all(|value| value.is_sensitive()));
        assert_eq!(headers["x-vs-ice-expires"], "125");
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    }

    #[test]
    fn configuration_rejects_redirectable_unbounded_and_injectable_values() {
        for url in [
            "turn:example.test:3478?transport=udp",
            "turn:8.8.8.8:3478?transport=udp",
            "turn:0.0.0.0:3478?transport=udp",
            "turn:127.0.0.1:80?transport=udp",
            "turn:127.0.0.1:3478?transport=tcp",
            "turns:127.0.0.1:3478?transport=udp",
            "turn:127.0.0.1:3478?transport=udp#fragment",
            "turn:127.0.0.1:3478?transport=udp\r\nX-Test: injected",
        ] {
            let mut config = fixture();
            config.servers[0].url = url.into();
            assert!(ClientIce::at(config, 100, Instant::now()).is_err());
        }
        for change in [
            "empty",
            "duplicate",
            "many",
            "password",
            "username",
            "expired",
            "long",
        ] {
            let mut config = fixture();
            match change {
                "empty" => config.servers.clear(),
                "duplicate" => config.servers.push(fixture().servers.remove(0)),
                "many" => {
                    config.servers = (0..5).map(|_| fixture().servers.remove(0)).collect();
                }
                "password" => config.servers[0].credential = "short".into(),
                "username" => config.servers[0].username = "user\r\n".into(),
                "expired" => config.expires_unix_seconds = 100,
                "long" => config.expires_unix_seconds = 401,
                _ => unreachable!(),
            }
            assert!(
                ClientIce::at(config, 100, Instant::now()).is_err(),
                "{change}"
            );
        }
    }

    #[test]
    fn either_wall_or_monotonic_expiry_stops_discovery() {
        let now = Instant::now();
        let ice = ClientIce::at(fixture(), 100, now).unwrap();
        assert!(ice.check_at(129, now + Duration::from_secs(29)).is_ok());
        assert!(ice.check_at(130, now).is_err());
        assert!(ice.check_at(99, now + Duration::from_secs(30)).is_err());
    }
}

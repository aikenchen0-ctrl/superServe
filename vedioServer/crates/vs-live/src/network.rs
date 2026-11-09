use std::{
    collections::BTreeSet,
    io,
    net::{IpAddr, SocketAddr},
    sync::Arc,
};

use serde::Deserialize;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateMediaNetwork {
    pub bind: SocketAddr,
    pub peer_ips: Vec<IpAddr>,
}

pub(crate) fn private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_private(),
        IpAddr::V6(ip) => ip.is_unique_local(),
    }
}

#[derive(Clone)]
pub(crate) enum MediaNetwork {
    Loopback,
    Private {
        bind: SocketAddr,
        peers: Arc<BTreeSet<IpAddr>>,
    },
}

impl PrivateMediaNetwork {
    pub fn check(&self) -> io::Result<()> {
        self.validate().map(|_| ())
    }

    pub(crate) fn validate(&self) -> io::Result<MediaNetwork> {
        let peers: BTreeSet<_> = self.peer_ips.iter().copied().collect();
        if self.bind.port() == 0
            || !private_ip(self.bind.ip())
            || !(1..=16).contains(&peers.len())
            || peers.len() != self.peer_ips.len()
            || peers
                .iter()
                .any(|ip| !private_ip(*ip) || ip.is_ipv4() != self.bind.ip().is_ipv4())
        {
            return Err(io::Error::other(
                "私网媒体须指定非零端口、明确私网网卡及1至16个同地址族唯一对端IP",
            ));
        }
        Ok(MediaNetwork::Private {
            bind: self.bind,
            peers: Arc::new(peers),
        })
    }
}

impl MediaNetwork {
    pub(crate) fn bind(&self) -> SocketAddr {
        match self {
            Self::Loopback => ([127, 0, 0, 1], 0).into(),
            Self::Private { bind, .. } => *bind,
        }
    }

    pub(crate) fn allows(&self, address: SocketAddr) -> bool {
        address.port() != 0
            && match self {
                Self::Loopback => address.ip().is_loopback(),
                Self::Private { peers, .. } => peers.contains(&address.ip()),
            }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_network_never_expands_the_default_and_requires_explicit_bounded_peers() {
        let config = PrivateMediaNetwork {
            bind: "10.20.0.2:45000".parse().unwrap(),
            peer_ips: vec!["10.20.0.3".parse().unwrap()],
        };
        let policy = config.validate().unwrap();
        for (address, expected) in [
            ("10.20.0.3:45001", true),
            ("10.20.0.4:45001", false),
            ("127.0.0.1:45001", false),
            ("8.8.8.8:45001", false),
            ("10.20.0.3:0", false),
        ] {
            let address = address.parse().unwrap();
            assert_eq!(policy.allows(address), expected);
            assert_eq!(
                MediaNetwork::Loopback.allows(address),
                address.ip().is_loopback() && address.port() != 0
            );
        }
        for bind in [
            "0.0.0.0:45000",
            "127.0.0.1:45000",
            "8.8.8.8:45000",
            "10.20.0.2:0",
        ] {
            assert!(
                PrivateMediaNetwork {
                    bind: bind.parse().unwrap(),
                    ..config.clone()
                }
                .validate()
                .is_err()
            );
        }
        for peers in [
            vec![],
            vec!["10.20.0.3"; 2],
            vec!["127.0.0.1"],
            vec!["169.254.169.254"],
            vec!["8.8.8.8"],
            vec!["fd00::1"],
        ] {
            assert!(
                PrivateMediaNetwork {
                    peer_ips: peers.iter().map(|ip| ip.parse().unwrap()).collect(),
                    ..config.clone()
                }
                .validate()
                .is_err()
            );
        }
        let oversized = PrivateMediaNetwork {
            peer_ips: (1..=17).map(|n| IpAddr::from([10, 20, 0, n])).collect(),
            ..config
        };
        assert!(oversized.validate().is_err());
    }
}

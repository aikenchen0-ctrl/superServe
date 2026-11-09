use std::{
    net::{Ipv4Addr, SocketAddr},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use tokio::net::UdpSocket;
use turn_client_proto::{
    api::{Transmit, TurnClientApi, TurnConfig as ClientConfig, TurnRecvRet},
    udp::TurnClientUdp,
};
use turn_types::{Instant, TransportType, TurnCredentials};
use vs_turn::{Credential, TurnConfig, TurnHandle};

const PASSWORD: &str = "turn-local-test-password-with-32-bytes";

fn epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn config(peer: SocketAddr, ports: usize) -> TurnConfig {
    let sockets: Vec<_> = (0..ports + 1)
        .map(|_| std::net::UdpSocket::bind("127.0.0.1:0").unwrap())
        .collect();
    TurnConfig {
        bind: sockets[0].local_addr().unwrap(),
        relay_ports: sockets[1..]
            .iter()
            .map(|socket| socket.local_addr().unwrap().port())
            .collect(),
        client_ips: vec![Ipv4Addr::LOCALHOST],
        peers: vec![peer],
        realm: "turn.test".into(),
        credentials: vec![Credential {
            username: "client".into(),
            password: PASSWORD.into(),
        }],
        expires_unix_seconds: epoch() + 120,
    }
}

struct Client {
    socket: UdpSocket,
    protocol: TurnClientUdp,
    base: std::time::Instant,
    received: Vec<Vec<u8>>,
}

impl Client {
    async fn new(server: SocketAddr, password: &str) -> Self {
        let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let protocol = TurnClientUdp::allocate(
            socket.local_addr().unwrap(),
            server,
            ClientConfig::new(TurnCredentials::new("client", password)),
        );
        Self {
            socket,
            protocol,
            base: std::time::Instant::now(),
            received: Vec::new(),
        }
    }

    async fn tick(&mut self) {
        let now = Instant::from_std(self.base);
        let _ = self.protocol.poll(now);
        while let Some(packet) = self.protocol.poll_transmit(now) {
            self.socket
                .send_to(packet.data.as_ref(), packet.to)
                .await
                .unwrap();
        }
        let mut buffer = [0; 8192];
        if let Ok(Ok((len, from))) = tokio::time::timeout(
            Duration::from_millis(20),
            self.socket.recv_from(&mut buffer),
        )
        .await
            && let TurnRecvRet::PeerData(data) = self.protocol.recv(
                Transmit::new(
                    &buffer[..len],
                    TransportType::Udp,
                    from,
                    self.socket.local_addr().unwrap(),
                ),
                Instant::from_std(self.base),
            )
        {
            self.received.push(data.data().to_vec());
        }
        while self.protocol.poll_event().is_some() {}
    }

    async fn until(&mut self, check: impl Fn(&Self) -> bool) {
        tokio::time::timeout(Duration::from_secs(4), async {
            while !check(self) {
                self.tick().await;
            }
        })
        .await
        .expect("TURN客户端未在期限内达到目标状态");
    }

    async fn drive(&mut self, duration: Duration) {
        let deadline = tokio::time::Instant::now() + duration;
        while tokio::time::Instant::now() < deadline {
            self.tick().await;
        }
    }

    async fn send(&mut self, peer: SocketAddr, bytes: &[u8]) {
        if let Some(packet) = self
            .protocol
            .send_to(
                TransportType::Udp,
                peer,
                bytes,
                Instant::from_std(self.base),
            )
            .unwrap()
        {
            let packet = packet.build();
            self.socket.send_to(&packet.data, packet.to).await.unwrap();
        }
    }
}

#[test]
fn config_rejects_unbounded_scope_credentials_ports_and_expiry() {
    let original = config("127.0.0.1:39999".parse().unwrap(), 2);
    let now = epoch();
    assert!(original.validate(now).is_ok());
    for case in [
        "public",
        "wildcard",
        "ipv6",
        "empty-clients",
        "duplicate-ports",
        "low-port",
        "own-peer",
        "relay-peer",
        "password",
        "duplicate-user",
        "expired",
        "long-lease",
        "many-ports",
    ] {
        let mut changed = original.clone();
        match case {
            "public" => changed.bind = "8.8.8.8:3478".parse().unwrap(),
            "wildcard" => changed.bind = "0.0.0.0:3478".parse().unwrap(),
            "ipv6" => changed.bind = "[::1]:3478".parse().unwrap(),
            "empty-clients" => changed.client_ips.clear(),
            "duplicate-ports" => changed.relay_ports.push(changed.relay_ports[0]),
            "low-port" => changed.relay_ports[0] = 80,
            "own-peer" => changed.peers = vec![changed.bind],
            "relay-peer" => {
                changed.peers = vec![SocketAddr::new(changed.bind.ip(), changed.relay_ports[0])]
            }
            "password" => changed.credentials[0].password = "short".into(),
            "duplicate-user" => changed.credentials.push(changed.credentials[0].clone()),
            "expired" => changed.expires_unix_seconds = now,
            "long-lease" => changed.expires_unix_seconds = now + 301,
            "many-ports" => changed.relay_ports = (40000..40009).collect(),
            _ => unreachable!(),
        }
        assert!(changed.validate(now).is_err(), "{case}");
    }
}

#[tokio::test]
async fn upstream_client_auth_allocates_real_port_relays_both_directions_and_blocks_other_peer_port()
 {
    let peer = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let forbidden = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let config = config(peer.local_addr().unwrap(), 2);
    let bind = config.bind;
    let server = TurnHandle::start(config).await.unwrap();
    let mut client = Client::new(bind, PASSWORD).await;
    client
        .until(|client| client.protocol.relayed_addresses().next().is_some())
        .await;
    let relay = client.protocol.relayed_addresses().next().unwrap().1;
    assert!(
        UdpSocket::bind(relay).await.is_err(),
        "中继必须占用真实系统端口"
    );
    client
        .protocol
        .create_permission(
            TransportType::Udp,
            peer.local_addr().unwrap().ip(),
            Instant::from_std(client.base),
        )
        .unwrap();
    client
        .until(|client| {
            client
                .protocol
                .have_permission(TransportType::Udp, peer.local_addr().unwrap().ip())
        })
        .await;
    client
        .send(peer.local_addr().unwrap(), b"\0real-turn\xff")
        .await;
    let mut bytes = [0; 1024];
    let (len, source) = tokio::time::timeout(Duration::from_secs(2), peer.recv_from(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&bytes[..len], b"\0real-turn\xff");
    assert_eq!(source, relay);
    peer.send_to(b"reverse-reply", relay).await.unwrap();
    client
        .until(|client| client.received.iter().any(|data| data == b"reverse-reply"))
        .await;
    client
        .protocol
        .create_permission(
            TransportType::Udp,
            "127.0.0.2".parse().unwrap(),
            Instant::from_std(client.base),
        )
        .unwrap();
    client.drive(Duration::from_millis(150)).await;
    assert!(
        !client
            .protocol
            .have_permission(TransportType::Udp, "127.0.0.2".parse().unwrap())
    );
    client
        .send(forbidden.local_addr().unwrap(), b"blocked-destination")
        .await;
    assert!(
        tokio::time::timeout(Duration::from_millis(200), forbidden.recv_from(&mut bytes))
            .await
            .is_err()
    );
    forbidden.send_to(b"blocked-source", relay).await.unwrap();
    client.drive(Duration::from_millis(200)).await;
    assert!(
        !client
            .received
            .iter()
            .any(|bytes| bytes == b"blocked-source")
    );
    let stats = server.shutdown().await.unwrap();
    assert!(stats.bytes_to_peer >= 11 && stats.bytes_from_peer >= 13);
    assert!(stats.blocked_bytes >= 33);
    assert_eq!(stats.active_allocations, 0);
    assert!(UdpSocket::bind(bind).await.is_ok());
    assert!(UdpSocket::bind(relay).await.is_ok());
}

#[tokio::test]
async fn wrong_credentials_cannot_allocate_and_capacity_recovers_after_explicit_delete() {
    let peer = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let cfg = config(peer.local_addr().unwrap(), 1);
    let bind = cfg.bind;
    let server = TurnHandle::start(cfg).await.unwrap();
    let mut wrong = Client::new(bind, "incorrect-password-with-32-bytes").await;
    wrong.drive(Duration::from_millis(400)).await;
    assert!(wrong.protocol.relayed_addresses().next().is_none());
    assert_eq!(server.stats().allocations_created, 0);
    let mut first = Client::new(bind, PASSWORD).await;
    first
        .until(|client| client.protocol.relayed_addresses().next().is_some())
        .await;
    let address = first.protocol.relayed_addresses().next().unwrap().1;
    let mut second = Client::new(bind, PASSWORD).await;
    second.drive(Duration::from_millis(400)).await;
    assert!(second.protocol.relayed_addresses().next().is_none());
    assert!(server.stats().allocations_refused > 0);
    first
        .protocol
        .delete(Instant::from_std(first.base))
        .unwrap();
    first
        .until(|client| {
            client.protocol.relayed_addresses().next().is_none()
                && server.stats().active_allocations == 0
        })
        .await;
    let mut third = Client::new(bind, PASSWORD).await;
    third
        .until(|client| client.protocol.relayed_addresses().next().is_some())
        .await;
    assert_eq!(
        third.protocol.relayed_addresses().next().unwrap().1,
        address
    );
    let stats = server.shutdown().await.unwrap();
    assert_eq!(stats.peak_allocations, 1);
    assert_eq!(stats.allocations_created, 2);
}

#[tokio::test]
async fn unknown_oversized_clients_and_global_expiry_do_not_create_or_keep_allocations() {
    let peer = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let mut cfg = config(peer.local_addr().unwrap(), 1);
    cfg.client_ips = vec!["127.0.0.2".parse().unwrap()];
    cfg.expires_unix_seconds = epoch() + 2;
    let bind = cfg.bind;
    let server = TurnHandle::start(cfg).await.unwrap();
    let sender = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    sender.send_to(&[0; 5000], bind).await.unwrap();
    sender.send_to(b"untrusted-client", bind).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !server.is_finished() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let stats = server.shutdown().await.unwrap();
    assert!(stats.expired);
    assert_eq!(stats.allocations_created, 0);
    assert_eq!(stats.admitted_clients, 0);
    assert!(stats.blocked_bytes > 0 && stats.oversize_bytes >= 5000);
    assert!(UdpSocket::bind(bind).await.is_ok());
}

#[tokio::test]
async fn expiry_terminates_an_existing_authenticated_allocation_and_releases_its_port() {
    let peer = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let mut cfg = config(peer.local_addr().unwrap(), 1);
    cfg.expires_unix_seconds = epoch() + 3;
    let bind = cfg.bind;
    let server = TurnHandle::start(cfg).await.unwrap();
    let mut client = Client::new(bind, PASSWORD).await;
    client
        .until(|client| client.protocol.relayed_addresses().next().is_some())
        .await;
    let relay = client.protocol.relayed_addresses().next().unwrap().1;
    assert!(UdpSocket::bind(relay).await.is_err());
    tokio::time::timeout(Duration::from_secs(4), async {
        while !server.is_finished() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let stats = server.shutdown().await.unwrap();
    assert!(stats.expired);
    assert_eq!(stats.allocations_created, 1);
    assert_eq!(stats.active_allocations, 0);
    assert!(UdpSocket::bind(relay).await.is_ok());
    assert!(UdpSocket::bind(bind).await.is_ok());
}

#[tokio::test]
async fn client_tuple_budget_is_not_evicted_by_more_source_ports() {
    let peer = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let cfg = config(peer.local_addr().unwrap(), 1);
    let bind = cfg.bind;
    let server = TurnHandle::start(cfg).await.unwrap();
    let clients = bind_clients(40).await;
    for (index, socket) in clients[..32].iter().enumerate() {
        socket.send_to(b"invalid-input", bind).await.unwrap();
        let expected = index + 1;
        tokio::time::timeout(Duration::from_secs(1), async {
            while server.stats().admitted_clients < expected {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    }
    for socket in &clients[32..] {
        socket.send_to(b"blocked-input", bind).await.unwrap();
    }
    tokio::time::timeout(Duration::from_secs(1), async {
        while server.stats().blocked_bytes == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let stats = server.shutdown().await.unwrap();
    assert_eq!(stats.admitted_clients, 32);
    assert_eq!(stats.allocations_created, 0);
}

async fn bind_clients(count: usize) -> Vec<UdpSocket> {
    let mut clients = Vec::new();
    for _ in 0..count {
        clients.push(UdpSocket::bind("127.0.0.1:0").await.unwrap());
    }
    clients
}

#[tokio::test]
async fn control_request_budget_is_distinct_from_media_datagrams() {
    use turn_types::{
        message::ALLOCATE,
        stun::message::{BINDING, Message, MessageWrite, MessageWriteVec},
    };
    let peer = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let cfg = config(peer.local_addr().unwrap(), 1);
    let bind = cfg.bind;
    let server = TurnHandle::start(cfg).await.unwrap();
    let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let mut bytes = [0; 2048];
    let initial = Message::builder_request(ALLOCATE, MessageWriteVec::new()).finish();
    client.send_to(&initial, bind).await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), client.recv_from(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    for _ in 0..511 {
        let request = Message::builder_request(BINDING, MessageWriteVec::new()).finish();
        client.send_to(&request, bind).await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), client.recv_from(&mut bytes))
            .await
            .unwrap()
            .unwrap();
    }
    let request = Message::builder_request(BINDING, MessageWriteVec::new()).finish();
    client.send_to(&request, bind).await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), client.recv_from(&mut bytes))
            .await
            .is_err()
    );
    let stats = server.shutdown().await.unwrap();
    assert_eq!(stats.control_requests, 512);
    assert_eq!(stats.control_requests_dropped, 1);
    assert_eq!(stats.allocations_created, 0);
}

#[test]
fn standalone_binary_expires_and_reclaims_its_listener() {
    standalone_lifecycle("expiry");
}

#[test]
fn standalone_parent_close_stops_before_expiry() {
    standalone_lifecycle("close");
}

#[test]
fn standalone_open_parent_pipe_does_not_block_expiry() {
    standalone_lifecycle("open");
}

#[test]
fn standalone_rejects_parent_commands_and_still_reclaims() {
    standalone_lifecycle("invalid");
}

struct Standalone {
    child: std::process::Child,
    directory: std::path::PathBuf,
}

impl Drop for Standalone {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(self.directory.join("config.json"));
        let _ = std::fs::remove_dir(&self.directory);
    }
}

fn standalone_lifecycle(mode: &str) {
    use std::io::{BufRead, Read, Write};

    let peer = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    let cfg = config(peer.local_addr().unwrap(), 1);
    let directory = std::env::temp_dir().join(format!(
        "turn-process-{}-{}-{mode}",
        std::process::id(),
        cfg.bind.port()
    ));
    std::fs::create_dir(&directory).unwrap();
    let path = directory.join("config.json");
    let expires = epoch()
        + if matches!(mode, "expiry" | "open") {
            3
        } else {
            30
        };
    let value = serde_json::json!({
        "bind":cfg.bind,"relay_ports":cfg.relay_ports,"client_ips":cfg.client_ips,"peers":cfg.peers,
        "realm":cfg.realm,"credentials":[{"username":"client","password":PASSWORD}],
        "expires_unix_seconds":expires
    });
    std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_vs-turn"));
    command
        .env("VS_TURN_CONFIG", &path)
        .env_remove("VS_TURN_STOP_ON_STDIN_EOF")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if mode != "expiry" {
        command.env("VS_TURN_STOP_ON_STDIN_EOF", "1");
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut process = Standalone {
        child: command.spawn().unwrap(),
        directory,
    };
    let output = process.child.stdout.take().unwrap();
    let errors = process.child.stderr.take().unwrap();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let reader = std::thread::spawn(move || {
        let mut source = std::io::BufReader::new(output).take(8193);
        let mut bytes = Vec::new();
        source.read_until(b'\n', &mut bytes).unwrap();
        let ready: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let _ = sender.send(ready);
        source.read_to_end(&mut bytes).unwrap();
        bytes
    });
    let error_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        errors.take(8193).read_to_end(&mut bytes).unwrap();
        bytes
    });
    let ready = receiver
        .recv_timeout(Duration::from_secs(2))
        .expect("独立TURN未在期限内就绪");
    assert_eq!(ready["schema"], "turn-lab-ready-v1");
    assert_eq!(ready["pid"], process.child.id());
    assert_eq!(ready["bind"], cfg.bind.to_string());
    assert_eq!(ready["expires_unix_seconds"], expires);
    assert_eq!(ready["shutdown_on_stdin_eof"], mode != "expiry");
    assert!(process.child.try_wait().unwrap().is_none());
    match mode {
        "close" => drop(process.child.stdin.take()),
        "invalid" => process
            .child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"x")
            .unwrap(),
        // 关闭未启用的管道不应影响原来的全局到期模式。
        "expiry" => drop(process.child.stdin.take()),
        "open" => {}
        _ => panic!("未知生命周期用例"),
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    let status = loop {
        if let Some(status) = process.child.try_wait().unwrap() {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            panic!("独立TURN程序未按期限退出");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let bytes = reader.join().unwrap();
    let errors = error_reader.join().unwrap();
    assert!(bytes.len() <= 8192 && errors.len() <= 8192);
    assert_eq!(status.success(), mode != "invalid");
    assert_eq!(errors.is_empty(), mode != "invalid");
    assert!(!String::from_utf8_lossy(&bytes).contains(PASSWORD));
    assert!(!String::from_utf8_lossy(&errors).contains(PASSWORD));
    let lines: Vec<serde_json::Value> = std::str::from_utf8(&bytes)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0], ready);
    assert_eq!(lines[1]["schema"], "turn-lab-stopped-v1");
    assert_eq!(lines[1]["pid"], process.child.id());
    assert_eq!(lines[1]["bind"], ready["bind"]);
    assert_eq!(
        lines[1]["reason"],
        match mode {
            "close" => "stdin_eof",
            "invalid" => "stdin_error",
            _ => "expired",
        }
    );
    assert_eq!(
        lines[1]["stats"]["expired"],
        matches!(mode, "expiry" | "open")
    );
    assert_eq!(lines[1]["stats"]["active_allocations"], 0);
    assert!(std::net::UdpSocket::bind(cfg.bind).is_ok());
    for port in cfg.relay_ports {
        assert!(std::net::UdpSocket::bind(SocketAddr::new(cfg.bind.ip(), port)).is_ok());
    }
}

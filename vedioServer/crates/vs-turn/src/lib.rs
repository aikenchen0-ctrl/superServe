// SPDX-License-Identifier: MIT
// 状态机接线改编turn-proto的api-tests，固定来源和修改范围见turn-proto-NOTICE.txt。
// Copyright (C) 2025 Matthew Waters <matthew@centricular.com>
use std::{
    collections::{BTreeMap, BTreeSet},
    io,
    net::{Ipv4Addr, SocketAddr},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tokio::{
    net::UdpSocket,
    sync::{mpsc, oneshot},
    task::{AbortHandle, JoinHandle, JoinSet},
};
use turn_server_proto::{
    api::{SocketAllocateError, TcpConnectError, Transmit, TurnServerApi, TurnServerPollRet},
    server::TurnServer,
};
use turn_types::{
    AddressFamily, Instant, TransportType,
    attribute::XorPeerAddress,
    message::CREATE_PERMISSION,
    stun::{
        attribute::{Attribute, AttributeStaticType},
        message::{Message, MessageClass},
    },
};

const MAX_CLIENTS: usize = 32;
const MAX_PACKET_BYTES: usize = 4096;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Credential {
    pub username: String,
    pub password: String,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurnConfig {
    pub bind: SocketAddr,
    pub relay_ports: Vec<u16>,
    pub client_ips: Vec<Ipv4Addr>,
    pub peers: Vec<SocketAddr>,
    pub realm: String,
    pub credentials: Vec<Credential>,
    pub expires_unix_seconds: u64,
}

fn allowed_ip(ip: Ipv4Addr) -> bool {
    ip.is_loopback() || ip.is_private()
}

fn text(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_graphic())
}

fn epoch() -> io::Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_secs())
        .map_err(|_| io::Error::other("TURN授权时钟不可用"))
}

impl TurnConfig {
    pub fn validate(&self, now: u64) -> io::Result<()> {
        let valid_address = |address: SocketAddr| {
            address.port() != 0
                && matches!(address.ip(), std::net::IpAddr::V4(ip) if allowed_ip(ip))
        };
        if !valid_address(self.bind)
            || !(1..=8).contains(&self.relay_ports.len())
            || self
                .relay_ports
                .iter()
                .any(|port| *port < 1024 || *port == self.bind.port())
            || self.relay_ports.iter().collect::<BTreeSet<_>>().len() != self.relay_ports.len()
            || !(1..=16).contains(&self.client_ips.len())
            || self.client_ips.iter().any(|ip| !allowed_ip(*ip))
            || self.client_ips.iter().collect::<BTreeSet<_>>().len() != self.client_ips.len()
            || !(1..=8).contains(&self.peers.len())
            || self.peers.iter().any(|peer| {
                !valid_address(*peer)
                    || *peer == self.bind
                    || peer.ip() == self.bind.ip() && self.relay_ports.contains(&peer.port())
            })
            || self.peers.iter().collect::<BTreeSet<_>>().len() != self.peers.len()
            || !text(&self.realm, 1, 64)
            || !(1..=8).contains(&self.credentials.len())
            || self
                .credentials
                .iter()
                .any(|user| !text(&user.username, 1, 64) || !text(&user.password, 32, 128))
            || self
                .credentials
                .iter()
                .map(|user| &user.username)
                .collect::<BTreeSet<_>>()
                .len()
                != self.credentials.len()
            || self.expires_unix_seconds <= now
            || self.expires_unix_seconds.saturating_sub(now) > 300
        {
            return Err(io::Error::other(
                "TURN须使用固定IPv4私网/回环地址、有限端口/对端/凭据及至多300秒授权",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Default, Serialize)]
pub struct TurnStats {
    pub admitted_clients: usize,
    pub active_allocations: usize,
    pub peak_allocations: usize,
    pub allocations_created: u64,
    pub allocations_refused: u64,
    pub bytes_to_peer: u64,
    pub bytes_from_peer: u64,
    pub bytes_to_client: u64,
    pub bytes_from_client: u64,
    pub blocked_bytes: u64,
    pub queue_dropped_bytes: u64,
    pub oversize_bytes: u64,
    pub io_feedback_errors: u64,
    pub control_requests: u64,
    pub control_requests_dropped: u64,
    pub stale_socket_bytes: u64,
    pub expired: bool,
}

#[derive(Default)]
struct ReaderCounters {
    dropped: AtomicU64,
    oversize: AtomicU64,
    feedback: AtomicU64,
}

struct Datagram {
    local: SocketAddr,
    generation: u64,
    from: SocketAddr,
    bytes: Vec<u8>,
}

struct Socket {
    udp: Arc<UdpSocket>,
    reader: AbortHandle,
    generation: u64,
}

pub struct TurnHandle {
    bind: SocketAddr,
    shared: Arc<Mutex<TurnStats>>,
    stop: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<io::Result<TurnStats>>>,
}

impl TurnHandle {
    pub async fn start(config: TurnConfig) -> io::Result<Self> {
        let wall = epoch()?;
        config.validate(wall)?;
        let udp = Arc::new(UdpSocket::bind(config.bind).await?);
        let bind = udp.local_addr()?;
        let shared = Arc::new(Mutex::new(TurnStats::default()));
        let publish = shared.clone();
        let (stop, stopped) = oneshot::channel();
        let task = tokio::spawn(run(config, udp, publish, stopped, wall));
        Ok(Self {
            bind,
            shared,
            stop: Some(stop),
            task: Some(task),
        })
    }

    pub fn bind(&self) -> SocketAddr {
        self.bind
    }

    pub fn stats(&self) -> TurnStats {
        self.shared
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub fn is_finished(&self) -> bool {
        self.task.as_ref().is_none_or(|task| task.is_finished())
    }

    pub async fn shutdown(mut self) -> io::Result<TurnStats> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        let mut task = self.task.take().unwrap();
        match tokio::time::timeout(Duration::from_secs(4), &mut task).await {
            Ok(result) => result.map_err(|_| io::Error::other("TURN任务异常退出"))?,
            Err(_) => {
                task.abort();
                let _ = task.await;
                Err(io::Error::other("TURN停机回收超时"))
            }
        }
    }
}

impl Drop for TurnHandle {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

fn reader(
    readers: &mut JoinSet<io::Result<()>>,
    socket: Arc<UdpSocket>,
    local: SocketAddr,
    generation: u64,
    tx: mpsc::Sender<Datagram>,
    counters: Arc<ReaderCounters>,
) -> AbortHandle {
    readers.spawn(async move {
        let mut bytes = vec![0; 65_536];
        loop {
            let (len, from) = match socket.recv_from(&mut bytes).await {
                Ok(value) => value,
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionRefused
                    ) =>
                {
                    counters.feedback.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
                Err(error) => return Err(error),
            };
            if len > MAX_PACKET_BYTES {
                counters.oversize.fetch_add(len as u64, Ordering::Relaxed);
                continue;
            }
            let packet = Datagram {
                local,
                generation,
                from,
                bytes: bytes[..len].to_vec(),
            };
            if tx.try_send(packet).is_err() {
                counters.dropped.fetch_add(len as u64, Ordering::Relaxed);
            }
        }
    })
}

struct Driver {
    config: TurnConfig,
    protocol: TurnServer,
    sockets: BTreeMap<SocketAddr, Socket>,
    clients: BTreeMap<SocketAddr, u16>,
    readers: JoinSet<io::Result<()>>,
    tx: mpsc::Sender<Datagram>,
    counters: Arc<ReaderCounters>,
    stats: TurnStats,
    deadline: std::time::Instant,
    wall: u64,
    next_generation: u64,
}

impl Driver {
    fn live(&mut self) -> io::Result<bool> {
        self.wall = self.wall.max(epoch()?);
        self.stats.expired |= self.wall >= self.config.expires_unix_seconds
            || std::time::Instant::now() >= self.deadline;
        Ok(!self.stats.expired)
    }

    async fn send(&mut self, packet: Transmit<Vec<u8>>) -> io::Result<()> {
        if !self.live()? {
            return Ok(());
        }
        let client = packet.from == self.config.bind;
        let permitted = packet.transport == TransportType::Udp
            && if client {
                self.clients.contains_key(&packet.to)
            } else {
                self.config.peers.contains(&packet.to)
            };
        if !permitted {
            self.stats.blocked_bytes += packet.data.len() as u64;
            return Ok(());
        }
        let Some(socket) = self.sockets.get(&packet.from) else {
            return Err(io::Error::other("TURN输出引用了未分配的套接字"));
        };
        match tokio::time::timeout(
            Duration::from_millis(100),
            socket.udp.send_to(&packet.data, packet.to),
        )
        .await
        {
            Ok(Ok(sent)) => {
                if client {
                    self.stats.bytes_to_client += sent as u64;
                } else {
                    self.stats.bytes_to_peer += sent as u64;
                }
            }
            Ok(Err(error))
                if matches!(
                    error.kind(),
                    io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionRefused
                ) =>
            {
                self.stats.io_feedback_errors += 1;
            }
            Ok(Err(error)) => return Err(error),
            Err(_) => self.stats.queue_dropped_bytes += packet.data.len() as u64,
        }
        Ok(())
    }

    async fn progress(&mut self, now: Instant) -> io::Result<Instant> {
        if !self.live()? {
            return Ok(now);
        }
        // 完整消费上游动作后才能再次接收数据；套接字和循环均有硬预算。
        for _ in 0..256 {
            match self.protocol.poll(now) {
                TurnServerPollRet::WaitUntil(deadline) => {
                    for _ in 0..256 {
                        let Some(packet) = self.protocol.poll_transmit(now) else {
                            return Ok(deadline);
                        };
                        self.send(packet).await?;
                    }
                    return Err(io::Error::other("TURN输出超出单轮预算"));
                }
                TurnServerPollRet::AllocateSocket {
                    transport,
                    listen_addr,
                    client_addr,
                    allocation_transport,
                    family,
                } => {
                    let mut allocated = Err(SocketAllocateError::InsufficientCapacity);
                    if allocation_transport != TransportType::Udp || family != AddressFamily::IPV4 {
                        allocated = Err(SocketAllocateError::AddressFamilyNotSupported);
                    } else {
                        for port in &self.config.relay_ports {
                            let local = SocketAddr::new(self.config.bind.ip(), *port);
                            if self.sockets.contains_key(&local) {
                                continue;
                            }
                            if let Ok(udp) = UdpSocket::bind(local).await {
                                let udp = Arc::new(udp);
                                let generation = self.next_generation;
                                self.next_generation = generation
                                    .checked_add(1)
                                    .ok_or_else(|| io::Error::other("TURN套接字代次耗尽"))?;
                                let reader = reader(
                                    &mut self.readers,
                                    udp.clone(),
                                    local,
                                    generation,
                                    self.tx.clone(),
                                    self.counters.clone(),
                                );
                                self.sockets.insert(
                                    local,
                                    Socket {
                                        udp,
                                        reader,
                                        generation,
                                    },
                                );
                                self.stats.allocations_created += 1;
                                self.stats.peak_allocations =
                                    self.stats.peak_allocations.max(self.sockets.len() - 1);
                                allocated = Ok(local);
                                break;
                            }
                        }
                    }
                    if allocated.is_err() {
                        self.stats.allocations_refused += 1;
                    }
                    self.protocol.allocated_socket(
                        transport,
                        listen_addr,
                        client_addr,
                        allocation_transport,
                        family,
                        allocated,
                        now,
                    );
                }
                TurnServerPollRet::SocketClose { listen_addr, .. } => {
                    if listen_addr == self.config.bind {
                        return Err(io::Error::other("TURN协议试图关闭控制监听"));
                    }
                    if let Some(socket) = self.sockets.remove(&listen_addr) {
                        let id = socket.reader.id();
                        socket.reader.abort();
                        drop(socket);
                        match self.readers.join_next().await {
                            Some(Err(error)) if error.is_cancelled() && error.id() == id => {}
                            _ => return Err(io::Error::other("TURN释放套接字时读取任务不符")),
                        }
                    }
                }
                TurnServerPollRet::TcpConnect {
                    relayed_addr,
                    peer_addr,
                    listen_addr,
                    client_addr,
                } => {
                    self.protocol.tcp_connected(
                        relayed_addr,
                        peer_addr,
                        listen_addr,
                        client_addr,
                        Err(TcpConnectError::Forbidden),
                        now,
                    );
                }
                TurnServerPollRet::TcpClose { .. } => {}
            }
        }
        Err(io::Error::other("TURN协议动作超出单轮预算"))
    }

    async fn receive(&mut self, packet: Datagram, now: Instant) -> io::Result<()> {
        if !self.live()? {
            return Ok(());
        }
        // 端口可重用，接收队列中的旧套接字代次不能因此取得新分配的归属。
        if self
            .sockets
            .get(&packet.local)
            .is_none_or(|socket| socket.generation != packet.generation)
        {
            self.stats.stale_socket_bytes += packet.bytes.len() as u64;
            return Ok(());
        }
        if packet.local == self.config.bind {
            let permitted = matches!(packet.from.ip(), std::net::IpAddr::V4(ip) if self.config.client_ips.contains(&ip));
            if !permitted
                || !self.clients.contains_key(&packet.from) && self.clients.len() >= MAX_CLIENTS
            {
                self.stats.blocked_bytes += packet.bytes.len() as u64;
                return Ok(());
            }
            let requests = self.clients.entry(packet.from).or_default();
            if let Ok(message) = Message::from_bytes(&packet.bytes) {
                if message.class() == MessageClass::Request {
                    if *requests >= 512 {
                        self.stats.control_requests_dropped += 1;
                        return Ok(());
                    }
                    *requests += 1;
                    self.stats.control_requests += 1;
                }
                // 权限只匹配IP，数据及ChannelBind仍限定完整端点；入站先限制权限集合。
                let mut peers = 0;
                for (_, raw) in message.iter_attributes() {
                    if raw.get_type() != XorPeerAddress::TYPE {
                        continue;
                    }
                    peers += 1;
                    let allowed = XorPeerAddress::try_from(&raw).is_ok_and(|peer| {
                        let address = peer.addr(message.transaction_id());
                        if message.has_method(CREATE_PERMISSION) {
                            self.config
                                .peers
                                .iter()
                                .any(|peer| peer.ip() == address.ip())
                        } else {
                            self.config.peers.contains(&address)
                        }
                    });
                    if !allowed || peers > 8 {
                        self.stats.blocked_bytes += packet.bytes.len() as u64;
                        return Ok(());
                    }
                }
            }
            self.stats.bytes_from_client += packet.bytes.len() as u64;
        } else if self.config.peers.contains(&packet.from) {
            self.stats.bytes_from_peer += packet.bytes.len() as u64;
        } else {
            self.stats.blocked_bytes += packet.bytes.len() as u64;
            return Ok(());
        }
        if let Some(reply) = self.protocol.recv(
            Transmit::new(packet.bytes, TransportType::Udp, packet.from, packet.local),
            now,
        ) {
            self.send(reply.build()).await?;
        }
        Ok(())
    }

    fn publish(&mut self, shared: &Mutex<TurnStats>) {
        self.stats.admitted_clients = self.clients.len();
        self.stats.active_allocations = self.sockets.len() - 1;
        self.stats.peak_allocations = self
            .stats
            .peak_allocations
            .max(self.stats.active_allocations);
        self.stats.queue_dropped_bytes += self.counters.dropped.swap(0, Ordering::Relaxed);
        self.stats.oversize_bytes += self.counters.oversize.swap(0, Ordering::Relaxed);
        self.stats.io_feedback_errors += self.counters.feedback.swap(0, Ordering::Relaxed);
        *shared.lock().unwrap_or_else(|error| error.into_inner()) = self.stats.clone();
    }
}

async fn run(
    config: TurnConfig,
    udp: Arc<UdpSocket>,
    shared: Arc<Mutex<TurnStats>>,
    mut stop: oneshot::Receiver<()>,
    wall: u64,
) -> io::Result<TurnStats> {
    let base = std::time::Instant::now();
    let deadline = base + Duration::from_secs(config.expires_unix_seconds - wall);
    let mut protocol = TurnServer::new(TransportType::Udp, config.bind, config.realm.clone());
    for user in &config.credentials {
        protocol.add_user(user.username.clone(), user.password.clone());
    }
    let (tx, mut rx) = mpsc::channel(32);
    let counters = Arc::new(ReaderCounters::default());
    let mut readers = JoinSet::new();
    let read = reader(
        &mut readers,
        udp.clone(),
        config.bind,
        0,
        tx.clone(),
        counters.clone(),
    );
    let sockets = BTreeMap::from([(
        config.bind,
        Socket {
            udp,
            reader: read,
            generation: 0,
        },
    )]);
    let mut driver = Driver {
        config,
        protocol,
        sockets,
        clients: BTreeMap::new(),
        readers,
        tx,
        counters,
        stats: TurnStats::default(),
        deadline,
        wall,
        next_generation: 1,
    };
    let mut clock = tokio::time::interval(Duration::from_millis(100));
    let outcome = loop {
        let now = Instant::from_std(base);
        let deadline = match driver.progress(now).await {
            Ok(deadline) => deadline,
            Err(error) => break Err(error),
        };
        driver.publish(&shared);
        if driver.stats.expired {
            break Ok(());
        }
        let wait = if deadline > now {
            deadline - now
        } else {
            Duration::ZERO
        }
        .min(Duration::from_millis(100));
        tokio::select! {
            _ = &mut stop => break Ok(()),
            _ = clock.tick() => {
                if let Err(error) = driver.live() { break Err(error); }
            }
            packet = rx.recv() => {
                let Some(packet) = packet else { break Err(io::Error::other("TURN接收队列异常关闭")); };
                if let Err(error) = driver.receive(packet, Instant::from_std(base)).await { break Err(error); }
            }
            result = driver.readers.join_next(), if !driver.readers.is_empty() => {
                if !matches!(result, Some(Err(ref error)) if error.is_cancelled()) {
                    break Err(io::Error::other("TURN套接字读取任务异常退出"));
                }
            }
            _ = tokio::time::sleep(wait) => {}
        }
    };
    driver.readers.shutdown().await;
    driver.publish(&shared);
    driver.sockets.clear();
    driver.stats.active_allocations = 0;
    *shared.lock().unwrap_or_else(|error| error.into_inner()) = driver.stats.clone();
    outcome.map(|_| driver.stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn queued_data_from_old_socket_cannot_cross_reuse_of_the_same_port() {
        let control = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
        let old = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let local = old.local_addr().unwrap();
        let peer = UdpSocket::bind("127.0.0.1:0")
            .await
            .unwrap()
            .local_addr()
            .unwrap();
        let now = epoch().unwrap();
        let config = TurnConfig {
            bind: control.local_addr().unwrap(),
            relay_ports: vec![local.port()],
            client_ips: vec![Ipv4Addr::LOCALHOST],
            peers: vec![peer],
            realm: "turn.test".into(),
            credentials: vec![Credential {
                username: "test".into(),
                password: "a".repeat(32),
            }],
            expires_unix_seconds: now + 30,
        };
        let mut protocol = TurnServer::new(TransportType::Udp, config.bind, config.realm.clone());
        protocol.add_user("test".into(), "a".repeat(32));
        let (tx, _rx) = mpsc::channel(32);
        let counters = Arc::new(ReaderCounters::default());
        let mut readers = JoinSet::new();
        let read = reader(
            &mut readers,
            control.clone(),
            config.bind,
            0,
            tx.clone(),
            counters.clone(),
        );
        let sockets = BTreeMap::from([(
            config.bind,
            Socket {
                udp: control,
                reader: read,
                generation: 0,
            },
        )]);
        let mut driver = Driver {
            config,
            protocol,
            sockets,
            clients: BTreeMap::new(),
            readers,
            tx,
            counters,
            stats: TurnStats::default(),
            deadline: std::time::Instant::now() + Duration::from_secs(30),
            wall: now,
            next_generation: 3,
        };
        let base = std::time::Instant::now();
        let delayed = || Datagram {
            local,
            generation: 1,
            from: peer,
            bytes: vec![1; 24],
        };
        drop(old);
        driver
            .receive(delayed(), Instant::from_std(base))
            .await
            .unwrap();
        let reused = Arc::new(UdpSocket::bind(local).await.unwrap());
        let read = reader(
            &mut driver.readers,
            reused.clone(),
            local,
            2,
            driver.tx.clone(),
            driver.counters.clone(),
        );
        driver.sockets.insert(
            local,
            Socket {
                udp: reused,
                reader: read,
                generation: 2,
            },
        );
        driver
            .receive(delayed(), Instant::from_std(base))
            .await
            .unwrap();
        assert_eq!(driver.stats.stale_socket_bytes, 48);
        assert_eq!(driver.stats.bytes_from_peer, 0);
        driver
            .receive(
                Datagram {
                    generation: 2,
                    ..delayed()
                },
                Instant::from_std(base),
            )
            .await
            .unwrap();
        assert_eq!(driver.stats.bytes_from_peer, 24);
        driver.readers.shutdown().await;
    }
}

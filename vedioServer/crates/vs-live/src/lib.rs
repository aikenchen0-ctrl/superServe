// SPDX-License-Identifier: MIT
// 改编str0m官方chat/http-post示例的分流、编码帧转发及关键帧反馈。
// Copyright 2022 Martin Algesten
use std::{
    io,
    net::UdpSocket,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use str0m::{
    Candidate, Event, Input, Output, Rtc,
    change::{SdpAnswer, SdpOffer},
    format::{CodecConfig, PayloadParams},
    media::{Direction, KeyframeRequestKind, MediaKind, Mid},
    net::{Protocol, Receive},
};
use tokio::sync::oneshot;

const MAX_SUBSCRIBERS: usize = 2;
pub const MAX_ROOMS: usize = 8;
const PEER_LEASE: Duration = Duration::from_secs(60);

pub mod access;
mod audio;
pub mod ice;
mod media_queue;
pub mod network;
mod revocation;
pub mod room_control;
mod video;
use media_queue::MediaQueues;
use revocation::Revocations;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PeerRole {
    Publisher,
    Subscriber,
}

#[derive(Debug, Clone, Copy)]
pub enum RelayError {
    Busy,
    Invalid,
    Conflict,
    Unavailable,
    Denied,
    NotFound,
    Precondition,
    IceRestartUnsupported,
}

#[derive(Clone)]
pub struct SessionGrant {
    pub subject: String,
    pub expires_unix_seconds: u64,
    pub assignment_revision: Option<u64>,
    pub token_digest: [u8; 32],
}

impl SessionGrant {
    fn remaining_at(&self, wall: Option<Duration>) -> Result<Duration, RelayError> {
        let at = wall.ok_or(RelayError::Denied)?;
        Duration::from_secs(self.expires_unix_seconds)
            .checked_sub(at)
            .filter(|remaining| !remaining.is_zero())
            .ok_or(RelayError::Denied)
    }
}

#[derive(Serialize)]
pub struct OfferReply {
    pub id: String,
    pub answer: SdpAnswer,
    pub lease_seconds: u64,
}

#[derive(Debug, Serialize)]
pub struct LeaseReply {
    pub lease_milliseconds: u64,
    pub expires_unix_seconds: u64,
}

#[derive(Debug, Serialize)]
pub struct RevocationReply {
    pub revoked_tokens: usize,
    pub removed_sessions: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct RelayStats {
    pub worker_alive: bool,
    pub active_peers: usize,
    pub publishers: usize,
    pub subscribers: usize,
    pub connected_peers: usize,
    pub accepted_sessions: u64,
    pub removed_sessions: u64,
    pub incoming_udp_payload_bytes: u64,
    pub outgoing_udp_payload_bytes: u64,
    pub encoded_frames_received: u64,
    pub encoded_frames_forwarded: u64,
    pub encoded_payload_bytes_forwarded: u64,
    pub keyframe_requests: u64,
    pub dropped_frames: u64,
    pub protocol_errors: u64,
    pub udp_feedback_errors: u64,
    pub queue_peak_bytes: usize,
    pub udp_port: u16,
    pub assignment_required: bool,
    pub assignment_revision: Option<u64>,
    pub drained_revision: u64,
    pub revoked_tokens: usize,
    pub reclaimed_revocations: u64,
    pub authorization_watermark_unix_seconds: Option<u64>,
    pub active_video_codec: Option<String>,
    pub active_audio_codec: Option<String>,
    pub audio_packets_received: u64,
    pub audio_packets_forwarded: u64,
    pub audio_payload_bytes_forwarded: u64,
    pub dropped_audio_packets: u64,
    pub audio_queue_peak_bytes: usize,
    pub trickle_updates: u64,
    pub trickled_candidates: u64,
    pub blocked_udp_payload_bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct WorkerStats {
    pub worker_alive: bool,
    pub room_slots: usize,
    pub udp_port: u16,
    pub incoming_udp_payload_bytes: u64,
    pub unassigned_udp_payload_bytes: u64,
    pub oversize_udp_packets: u64,
    pub udp_feedback_errors: u64,
    pub blocked_udp_payload_bytes: u64,
}

enum Command {
    CheckAccess(SessionGrant, oneshot::Sender<Result<(), RelayError>>),
    Offer(
        PeerRole,
        SdpOffer,
        Option<SessionGrant>,
        oneshot::Sender<Result<OfferReply, RelayError>>,
    ),
    Remove(
        String,
        Option<PeerRole>,
        Option<SessionGrant>,
        oneshot::Sender<Result<bool, RelayError>>,
    ),
    Exists(
        String,
        PeerRole,
        Option<SessionGrant>,
        oneshot::Sender<Result<bool, RelayError>>,
    ),
    Activate(u64, oneshot::Sender<Result<usize, RelayError>>),
    Drain(u64, oneshot::Sender<Result<usize, RelayError>>),
    Renew(
        String,
        PeerRole,
        SessionGrant,
        oneshot::Sender<Result<LeaseReply, RelayError>>,
    ),
    Revoke(
        u64,
        SessionGrant,
        oneshot::Sender<Result<RevocationReply, RelayError>>,
    ),
    Trickle(
        String,
        PeerRole,
        Option<SessionGrant>,
        String,
        ice::IceFragment,
        oneshot::Sender<Result<usize, RelayError>>,
    ),
}

fn command_error<T>(error: mpsc::TrySendError<T>) -> RelayError {
    match error {
        mpsc::TrySendError::Full(_) => RelayError::Busy,
        mpsc::TrySendError::Disconnected(_) => RelayError::Unavailable,
    }
}

fn udp_feedback(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionRefused
    )
}

#[derive(Clone)]
pub struct Relay {
    tx: SyncSender<Command>,
    stats: Arc<Mutex<RelayStats>>,
    worker_stats: Arc<Mutex<WorkerStats>>,
    wake: thread::Thread,
}

pub struct RelayWorker {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<io::Result<()>>>,
}

impl RelayWorker {
    pub fn shutdown(mut self) -> io::Result<()> {
        self.stop.store(true, Ordering::Release);
        self.join.as_ref().unwrap().thread().unpark();
        self.join
            .take()
            .unwrap()
            .join()
            .map_err(|_| io::Error::other("实时媒体工作线程异常"))?
    }
}

impl Drop for RelayWorker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(join) = &self.join {
            join.thread().unpark();
        }
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Relay {
    pub async fn check_access(&self, grant: SessionGrant) -> Result<(), RelayError> {
        let (reply, receive) = oneshot::channel();
        self.send(Command::CheckAccess(grant, reply))?;
        tokio::time::timeout(Duration::from_secs(2), receive)
            .await
            .map_err(|_| RelayError::Unavailable)?
            .map_err(|_| RelayError::Unavailable)?
    }

    pub async fn trickle(
        &self,
        id: &str,
        role: PeerRole,
        grant: Option<SessionGrant>,
        etag: String,
        fragment: ice::IceFragment,
    ) -> Result<usize, RelayError> {
        let (reply, receive) = oneshot::channel();
        self.send(Command::Trickle(
            id.into(),
            role,
            grant,
            etag,
            fragment,
            reply,
        ))?;
        tokio::time::timeout(Duration::from_secs(2), receive)
            .await
            .map_err(|_| RelayError::Unavailable)?
            .map_err(|_| RelayError::Unavailable)?
    }

    pub fn start() -> io::Result<(Self, RelayWorker)> {
        Self::start_inner(false)
    }

    pub fn start_guarded() -> io::Result<(Self, RelayWorker)> {
        Self::start_inner(true)
    }

    fn start_inner(assignment_required: bool) -> io::Result<(Self, RelayWorker)> {
        let (mut rooms, worker) = Self::start_rooms(1, assignment_required)?;
        Ok((rooms.remove(0), worker))
    }

    pub fn start_rooms(
        count: usize,
        assignment_required: bool,
    ) -> io::Result<(Vec<Self>, RelayWorker)> {
        Self::start_rooms_network(count, assignment_required, network::MediaNetwork::Loopback)
    }

    pub fn start_rooms_private(
        count: usize,
        config: network::PrivateMediaNetwork,
    ) -> io::Result<(Vec<Self>, RelayWorker)> {
        Self::start_rooms_network(count, true, config.validate()?)
    }

    fn start_rooms_network(
        count: usize,
        assignment_required: bool,
        network: network::MediaNetwork,
    ) -> io::Result<(Vec<Self>, RelayWorker)> {
        if !(1..=MAX_ROOMS).contains(&count) {
            return Err(io::Error::other("媒体工作器的房间数量须为1至8"));
        }
        let socket = UdpSocket::bind(network.bind())?;
        socket.set_write_timeout(Some(Duration::from_millis(100)))?;
        let port = socket.local_addr()?.port();
        let shared_worker = Arc::new(Mutex::new(WorkerStats {
            worker_alive: true,
            room_slots: count,
            udp_port: port,
            ..Default::default()
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let mut senders = Vec::with_capacity(count);
        let mut slots = Vec::with_capacity(count);
        let mut worker_stats = Vec::with_capacity(count);
        for _ in 0..count {
            let stats = Arc::new(Mutex::new(RelayStats {
                worker_alive: true,
                udp_port: port,
                assignment_required,
                ..Default::default()
            }));
            let (tx, rx) = mpsc::sync_channel(4);
            let mut room = Room::new(port, assignment_required);
            room.network = network.clone();
            slots.push(RoomSlot {
                room,
                rx,
                shared: stats.clone(),
            });
            worker_stats.push(stats.clone());
            senders.push((tx, stats));
        }
        let worker_stop = stop.clone();
        let publish_worker = shared_worker.clone();
        let join = thread::Builder::new()
            .name("vs-live-media".into())
            .spawn(move || {
                let result = run(socket, slots, worker_stop, publish_worker.clone(), network);
                if let Err(error) = &result {
                    tracing::error!(%error, "实时媒体工作线程已退出");
                }
                for stats in worker_stats {
                    if let Ok(mut stats) = stats.lock() {
                        stats.worker_alive = false;
                    }
                }
                if let Ok(mut stats) = publish_worker.lock() {
                    stats.worker_alive = false;
                }
                result
            })?;
        let wake = join.thread().clone();
        Ok((
            senders
                .into_iter()
                .map(|(tx, stats)| Self {
                    tx,
                    stats,
                    worker_stats: shared_worker.clone(),
                    wake: wake.clone(),
                })
                .collect(),
            RelayWorker {
                stop,
                join: Some(join),
            },
        ))
    }

    fn send(&self, command: Command) -> Result<(), RelayError> {
        self.tx.try_send(command).map_err(command_error)?;
        self.wake.unpark();
        Ok(())
    }

    pub async fn offer(&self, role: PeerRole, offer: SdpOffer) -> Result<OfferReply, RelayError> {
        self.offer_inner(role, offer, None).await
    }

    pub async fn offer_authorized(
        &self,
        role: PeerRole,
        offer: SdpOffer,
        grant: SessionGrant,
    ) -> Result<OfferReply, RelayError> {
        self.offer_inner(role, offer, Some(grant)).await
    }

    async fn offer_inner(
        &self,
        role: PeerRole,
        offer: SdpOffer,
        grant: Option<SessionGrant>,
    ) -> Result<OfferReply, RelayError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::Offer(role, offer, grant, tx))?;
        tokio::time::timeout(Duration::from_secs(5), rx)
            .await
            .map_err(|_| RelayError::Unavailable)?
            .map_err(|_| RelayError::Unavailable)?
    }

    pub async fn remove(&self, id: &str) -> Result<bool, RelayError> {
        self.remove_matching(id, None, None).await
    }

    pub async fn remove_for_role(&self, id: &str, role: PeerRole) -> Result<bool, RelayError> {
        self.remove_matching(id, Some(role), None).await
    }

    pub async fn remove_owned(
        &self,
        id: &str,
        role: PeerRole,
        grant: SessionGrant,
    ) -> Result<bool, RelayError> {
        self.remove_matching(id, Some(role), Some(grant)).await
    }

    async fn remove_matching(
        &self,
        id: &str,
        role: Option<PeerRole>,
        grant: Option<SessionGrant>,
    ) -> Result<bool, RelayError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::Remove(id.into(), role, grant, tx))?;
        tokio::time::timeout(Duration::from_secs(2), rx)
            .await
            .map_err(|_| RelayError::Unavailable)?
            .map_err(|_| RelayError::Unavailable)?
    }

    pub async fn exists(&self, id: &str, role: PeerRole) -> Result<bool, RelayError> {
        self.exists_matching(id, role, None).await
    }

    pub async fn exists_owned(
        &self,
        id: &str,
        role: PeerRole,
        grant: SessionGrant,
    ) -> Result<bool, RelayError> {
        self.exists_matching(id, role, Some(grant)).await
    }

    async fn exists_matching(
        &self,
        id: &str,
        role: PeerRole,
        grant: Option<SessionGrant>,
    ) -> Result<bool, RelayError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::Exists(id.into(), role, grant, tx))?;
        tokio::time::timeout(Duration::from_secs(2), rx)
            .await
            .map_err(|_| RelayError::Unavailable)?
            .map_err(|_| RelayError::Unavailable)?
    }

    pub fn stats(&self) -> io::Result<RelayStats> {
        self.stats
            .lock()
            .map(|stats| stats.clone())
            .map_err(|_| io::Error::other("实时媒体观测不可用"))
    }

    pub fn worker_stats(&self) -> io::Result<WorkerStats> {
        self.worker_stats
            .lock()
            .map(|stats| stats.clone())
            .map_err(|_| io::Error::other("媒体工作器观测不可用"))
    }

    pub async fn activate(&self, revision: u64) -> Result<usize, RelayError> {
        self.control(revision, true).await
    }

    pub async fn drain_room(&self, revision: u64) -> Result<usize, RelayError> {
        self.control(revision, false).await
    }

    pub async fn renew(
        &self,
        id: &str,
        role: PeerRole,
        grant: SessionGrant,
    ) -> Result<LeaseReply, RelayError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::Renew(id.into(), role, grant, tx))?;
        tokio::time::timeout(Duration::from_secs(2), rx)
            .await
            .map_err(|_| RelayError::Unavailable)?
            .map_err(|_| RelayError::Unavailable)?
    }

    pub async fn revoke(
        &self,
        revision: u64,
        grant: SessionGrant,
    ) -> Result<RevocationReply, RelayError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::Revoke(revision, grant, tx))?;
        tokio::time::timeout(Duration::from_secs(2), rx)
            .await
            .map_err(|_| RelayError::Unavailable)?
            .map_err(|_| RelayError::Unavailable)?
    }

    async fn control(&self, revision: u64, activate: bool) -> Result<usize, RelayError> {
        let (tx, rx) = oneshot::channel();
        let command = if activate {
            Command::Activate(revision, tx)
        } else {
            Command::Drain(revision, tx)
        };
        self.send(command)?;
        tokio::time::timeout(Duration::from_secs(2), rx)
            .await
            .map_err(|_| RelayError::Unavailable)?
            .map_err(|_| RelayError::Unavailable)?
    }
}

struct Peer {
    id: String,
    role: PeerRole,
    rtc: Rtc,
    mid: Option<Mid>,
    connected: bool,
    failed: bool,
    expires: Instant,
    authorization_deadline: Option<Instant>,
    grant: Option<SessionGrant>,
    deadline: Instant,
    payload: PayloadParams,
    audio: Option<AudioTrack>,
    remote_ice: ice::RemoteIce,
    network: network::MediaNetwork,
}

struct AudioTrack {
    mid: Mid,
    payload: PayloadParams,
}

impl Peer {
    fn renew(
        &mut self,
        grant: SessionGrant,
        at: Instant,
        wall: Duration,
    ) -> Result<LeaseReply, RelayError> {
        let current = self.grant.as_ref().ok_or(RelayError::NotFound)?;
        let cap = self.authorization_deadline.ok_or(RelayError::NotFound)?;
        if self.failed
            || !self.rtc.is_alive()
            || self.expires <= at
            || cap <= at
            || wall >= Duration::from_secs(current.expires_unix_seconds)
        {
            return Err(RelayError::NotFound);
        }
        let remaining = Duration::from_secs(grant.expires_unix_seconds)
            .checked_sub(wall)
            .filter(|remaining| !remaining.is_zero())
            .ok_or(RelayError::Denied)?;
        if grant.assignment_revision != current.assignment_revision
            || grant.expires_unix_seconds < current.expires_unix_seconds
            || (grant.expires_unix_seconds == current.expires_unix_seconds
                && grant.token_digest != current.token_digest)
        {
            return Err(RelayError::Conflict);
        }
        if grant.expires_unix_seconds > current.expires_unix_seconds {
            // 绝对到期差映射到既有单调期限，回拨墙钟不能额外延长授权。
            let delta =
                Duration::from_secs(grant.expires_unix_seconds - current.expires_unix_seconds);
            let next_cap = cap
                .checked_add(delta)
                .ok_or(RelayError::Denied)?
                .min(at + remaining);
            self.expires = (at + PEER_LEASE).min(next_cap);
            self.authorization_deadline = Some(next_cap);
            self.grant = Some(grant);
        }
        // 相同到期凭据只返回现状；响应丢失后重试不能再次滑动期限。
        Ok(LeaseReply {
            lease_milliseconds: self.expires.saturating_duration_since(at).as_millis() as u64,
            expires_unix_seconds: self.grant.as_ref().unwrap().expires_unix_seconds,
        })
    }
}

struct Room {
    peers: Vec<Peer>,
    frames: MediaQueues,
    request_keyframe: bool,
    last_keyframe: Option<Instant>,
    stats: RelayStats,
    revoked: Revocations,
    network: network::MediaNetwork,
}

impl Room {
    fn new(port: u16, assignment_required: bool) -> Self {
        Self {
            peers: Vec::new(),
            frames: MediaQueues::default(),
            request_keyframe: false,
            last_keyframe: None,
            stats: RelayStats {
                worker_alive: true,
                udp_port: port,
                assignment_required,
                ..Default::default()
            },
            revoked: Revocations::default(),
            network: network::MediaNetwork::Loopback,
        }
    }

    fn check_grant(&self, grant: &SessionGrant, wall: Option<Duration>) -> Result<(), RelayError> {
        if self.stats.assignment_required
            && (self.stats.assignment_revision.is_none()
                || grant.assignment_revision != self.stats.assignment_revision)
        {
            return Err(RelayError::Conflict);
        }
        if self.revoked.contains(&grant.token_digest) {
            return Err(RelayError::Denied);
        }
        grant.remaining_at(wall).map(|_| ())
    }

    fn expire(&mut self, at: Instant, wall: Option<Duration>) {
        let expired: Vec<_> = self
            .peers
            .iter()
            .filter(|peer| {
                peer.failed
                    || !peer.rtc.is_alive()
                    || peer.expires <= at
                    || peer.grant.as_ref().is_some_and(|grant| {
                        wall.is_none_or(|wall| {
                            wall >= Duration::from_secs(grant.expires_unix_seconds)
                        })
                    })
            })
            .map(|peer| peer.id.clone())
            .collect();
        for id in expired {
            self.remove(&id, None, None);
        }
    }

    fn remove(&mut self, id: &str, role: Option<PeerRole>, subject: Option<&str>) -> bool {
        let Some(index) = self.peers.iter().position(|peer| {
            peer.id == id
                && role.is_none_or(|role| peer.role == role)
                && subject.is_none_or(|subject| {
                    peer.grant
                        .as_ref()
                        .is_some_and(|grant| grant.subject == subject)
                })
        }) else {
            return false;
        };
        let publisher = self.peers[index].role == PeerRole::Publisher;
        self.peers.remove(index);
        self.stats.removed_sessions += 1;
        if publisher {
            self.stats.removed_sessions += self.peers.len() as u64;
            self.peers.clear();
            self.frames.clear();
        }
        true
    }

    fn publish_stats(&mut self, shared: &Mutex<RelayStats>) {
        self.stats.revoked_tokens = self.revoked.len();
        self.stats.reclaimed_revocations = self.revoked.reclaimed();
        self.stats.authorization_watermark_unix_seconds = self.revoked.watermark_seconds();
        self.stats.active_peers = self.peers.len();
        self.stats.publishers = self
            .peers
            .iter()
            .filter(|peer| peer.role == PeerRole::Publisher)
            .count();
        self.stats.subscribers = self.peers.len() - self.stats.publishers;
        self.stats.connected_peers = self.peers.iter().filter(|peer| peer.connected).count();
        self.stats.active_video_codec = self
            .peers
            .iter()
            .find(|peer| peer.role == PeerRole::Publisher)
            .map(|peer| video::name(peer.payload.spec().codec).into());
        self.stats.active_audio_codec = self
            .peers
            .iter()
            .find(|peer| peer.role == PeerRole::Publisher)
            .and_then(|peer| peer.audio.as_ref().map(|_| "opus".into()));
        if let Ok(mut value) = shared.lock() {
            *value = self.stats.clone();
        }
    }

    fn command(&mut self, command: Command, socket: &UdpSocket) {
        // 队列等待和前一条协商可能跨过期限；控制命令不能复活尚未清理的旧会话。
        let at = Instant::now();
        let wall = self
            .revoked
            .observe(SystemTime::now().duration_since(UNIX_EPOCH).ok());
        self.expire(at, wall);
        match command {
            Command::CheckAccess(grant, reply) => {
                if !reply.is_closed() {
                    let _ = reply.send(self.check_grant(&grant, wall));
                }
            }
            Command::Trickle(id, role, grant, etag, fragment, reply) => {
                if reply.is_closed() {
                    return;
                }
                let result = (|| {
                    if let Some(grant) = &grant {
                        self.check_grant(grant, wall)?;
                    }
                    let peer = self
                        .peers
                        .iter_mut()
                        .find(|peer| {
                            peer.id == id
                                && peer.role == role
                                && match (&peer.grant, &grant) {
                                    (None, None) => true,
                                    (Some(current), Some(grant)) => {
                                        current.subject == grant.subject
                                    }
                                    _ => false,
                                }
                        })
                        .ok_or(RelayError::NotFound)?;
                    if etag == "*" {
                        return Err(RelayError::IceRestartUnsupported);
                    }
                    if etag != format!("\"{}\"", peer.id) {
                        return Err(RelayError::Precondition);
                    }
                    let candidates = peer.remote_ice.prepare(fragment)?;
                    let added = candidates.len();
                    for (key, candidate) in candidates {
                        peer.rtc.add_remote_candidate(candidate);
                        // str0m要求每次公开状态修改后完整排出输出，不能等整批添加后才排出。
                        peer.deadline = match drain(
                            peer,
                            socket,
                            &mut self.frames,
                            &mut self.stats,
                            &mut self.request_keyframe,
                        ) {
                            Ok(deadline) => deadline,
                            Err(reason) => {
                                peer.failed = true;
                                return Err(reason);
                            }
                        };
                        peer.remote_ice.remember(key);
                    }
                    self.stats.trickle_updates += 1;
                    self.stats.trickled_candidates += added as u64;
                    Ok(added)
                })();
                let _ = reply.send(result);
            }
            Command::Activate(revision, reply) => {
                let result = if !self.stats.assignment_required
                    || revision == 0
                    || revision > 9_007_199_254_740_991
                    || revision <= self.stats.drained_revision
                    || self
                        .stats
                        .assignment_revision
                        .is_some_and(|current| current != revision)
                {
                    Err(RelayError::Conflict)
                } else {
                    self.stats.assignment_revision = Some(revision);
                    Ok(self.peers.len())
                };
                let _ = reply.send(result);
            }
            Command::Drain(revision, reply) => {
                if !self.stats.assignment_required
                    || revision == 0
                    || revision > 9_007_199_254_740_991
                    || revision < self.stats.drained_revision
                    || self
                        .stats
                        .assignment_revision
                        .is_some_and(|current| revision < current)
                {
                    let _ = reply.send(Err(RelayError::Conflict));
                    return;
                }
                // 同一线程先封闭接入，再移除全部Rtc和排队帧，之后才发出排空确认。
                self.stats.assignment_revision = None;
                self.stats.drained_revision = revision;
                self.stats.removed_sessions += self.peers.len() as u64;
                self.peers.clear();
                self.frames.clear();
                self.revoked.clear_drained();
                self.request_keyframe = false;
                self.last_keyframe = None;
                let _ = reply.send(Ok(0));
            }
            Command::Remove(id, role, grant, reply) => {
                let result = grant
                    .as_ref()
                    .map(|grant| self.check_grant(grant, wall))
                    .transpose()
                    .map(|_| {
                        self.remove(
                            &id,
                            role,
                            grant.as_ref().map(|grant| grant.subject.as_str()),
                        )
                    });
                let _ = reply.send(result);
            }
            Command::Exists(id, role, grant, reply) => {
                let result = grant
                    .as_ref()
                    .map(|grant| self.check_grant(grant, wall))
                    .transpose()
                    .map(|_| {
                        self.peers.iter().any(|peer| {
                            peer.id == id
                                && peer.role == role
                                && grant.as_ref().is_none_or(|grant| {
                                    peer.grant
                                        .as_ref()
                                        .is_some_and(|current| current.subject == grant.subject)
                                })
                        })
                    });
                let _ = reply.send(result);
            }
            Command::Revoke(revision, grant, reply) => {
                // 重复撤权仍需返回已执行结果，不因HTTP等待者取消而撤销已经接收的控制操作。
                let result = if !self.stats.assignment_required
                    || self.stats.assignment_revision != Some(revision)
                    || grant.assignment_revision != Some(revision)
                {
                    Err(RelayError::Conflict)
                } else if grant.remaining_at(wall).is_err() {
                    Err(RelayError::Denied)
                } else if let Err(reason) = self.revoked.insert(&grant) {
                    Err(reason)
                } else {
                    let before = self.stats.removed_sessions;
                    let ids: Vec<_> = self
                        .peers
                        .iter()
                        .filter(|peer| {
                            peer.grant
                                .as_ref()
                                .is_some_and(|current| current.token_digest == grant.token_digest)
                        })
                        .map(|peer| peer.id.clone())
                        .collect();
                    for id in ids {
                        self.remove(&id, None, None);
                    }
                    Ok(RevocationReply {
                        revoked_tokens: self.revoked.len(),
                        removed_sessions: self.stats.removed_sessions - before,
                    })
                };
                let _ = reply.send(result);
            }
            Command::Renew(id, role, grant, reply) => {
                if reply.is_closed() {
                    return;
                }
                let result = if let Err(reason) = self.check_grant(&grant, wall) {
                    Err(reason)
                } else if let Some(peer) = self.peers.iter_mut().find(|peer| {
                    peer.id == id
                        && peer.role == role
                        && peer
                            .grant
                            .as_ref()
                            .is_some_and(|current| current.subject == grant.subject)
                }) {
                    wall.ok_or(RelayError::Denied)
                        .and_then(|wall| peer.renew(grant, at, wall))
                } else {
                    Err(RelayError::NotFound)
                };
                let _ = reply.send(result);
            }
            Command::Offer(role, offer, grant, reply) => {
                if reply.is_closed() {
                    return;
                }
                if self.stats.assignment_required
                    && (self.stats.assignment_revision.is_none()
                        || grant.as_ref().and_then(|grant| grant.assignment_revision)
                            != self.stats.assignment_revision)
                {
                    let _ = reply.send(Err(RelayError::Conflict));
                    return;
                }
                if let Some(grant) = &grant
                    && let Err(reason) = self.check_grant(grant, wall)
                {
                    let _ = reply.send(Err(reason));
                    return;
                }
                let publishers = self
                    .peers
                    .iter()
                    .filter(|peer| peer.role == PeerRole::Publisher)
                    .count();
                let subscribers = self.peers.len() - publishers;
                if (role == PeerRole::Publisher && publishers != 0)
                    || (role == PeerRole::Subscriber && publishers == 0)
                {
                    let _ = reply.send(Err(RelayError::Conflict));
                    return;
                }
                if role == PeerRole::Subscriber && subscribers >= MAX_SUBSCRIBERS {
                    let _ = reply.send(Err(RelayError::Busy));
                    return;
                }
                match self.negotiate(role, offer, socket) {
                    Ok((mut peer, answer)) => {
                        let at = Instant::now();
                        let wall = self
                            .revoked
                            .observe(SystemTime::now().duration_since(UNIX_EPOCH).ok());
                        let remaining = match grant
                            .as_ref()
                            .map(|grant| grant.remaining_at(wall))
                            .transpose()
                        {
                            Ok(remaining) => remaining,
                            Err(reason) => {
                                let _ = reply.send(Err(reason));
                                return;
                            }
                        };
                        let lease = remaining.unwrap_or(PEER_LEASE).min(PEER_LEASE);
                        peer.authorization_deadline = remaining.map(|remaining| at + remaining);
                        peer.expires = at + lease;
                        peer.grant = grant;
                        let response = OfferReply {
                            id: peer.id.clone(),
                            answer,
                            lease_seconds: lease.as_secs(),
                        };
                        // 没有等待者时直接丢弃会话；HTTP响应丢失后的残余会话受固定租期限制。
                        if reply.send(Ok(response)).is_ok() {
                            self.peers.push(peer);
                            self.stats.accepted_sessions += 1;
                        }
                    }
                    Err(error) => {
                        let _ = reply.send(Err(error));
                    }
                }
            }
        }
    }

    fn negotiate(
        &mut self,
        role: PeerRole,
        offer: SdpOffer,
        socket: &UdpSocket,
    ) -> Result<(Peer, SdpAnswer), RelayError> {
        if !(1..=2).contains(&offer.media_lines.len()) {
            return Err(RelayError::Invalid);
        }
        let remote_direction = if role == PeerRole::Publisher {
            Direction::SendOnly
        } else {
            Direction::RecvOnly
        };
        if offer.media_lines.iter().any(|media| {
            media.disabled
                || (media.direction() != remote_direction
                    && media.direction() != Direction::SendRecv)
                || media.simulcast().is_some()
                || !media.rids().is_empty()
        }) {
            return Err(RelayError::Invalid);
        }
        let videos: Vec<_> = offer
            .media_lines
            .iter()
            .filter(|media| media.typ.to_string() == "video")
            .collect();
        let audios: Vec<_> = offer
            .media_lines
            .iter()
            .filter(|media| media.typ.to_string() == "audio")
            .collect();
        if videos.len() != 1
            || audios.len() > 1
            || videos.len() + audios.len() != offer.media_lines.len()
        {
            return Err(RelayError::Invalid);
        }
        let media = videos[0];
        let source_peer = if role == PeerRole::Subscriber {
            Some(
                self.peers
                    .iter()
                    .find(|peer| peer.role == PeerRole::Publisher)
                    .ok_or(RelayError::Conflict)?,
            )
        } else {
            None
        };
        let source = source_peer.map(|peer| peer.payload);
        let selected = video::select(&media.rtp_params(), source)?;
        let audio = audios
            .first()
            .map(|media| {
                let source = source_peer
                    .map(|peer| {
                        peer.audio
                            .as_ref()
                            .map(|audio| audio.payload)
                            .ok_or(RelayError::Conflict)
                    })
                    .transpose()?;
                let payload = audio::select(&media.rtp_params(), source)?;
                Ok::<_, RelayError>(AudioTrack {
                    mid: media.mid(),
                    payload,
                })
            })
            .transpose()?;
        let mut normalized = (*offer).clone();
        for media in &mut normalized.media_lines {
            if media.direction() == Direction::SendRecv {
                media.set_direction(remote_direction);
            }
        }
        let offer = normalized.into();
        let remote_ice = ice::RemoteIce::from_offer(&offer)?;
        let mut identifier = [0_u8; 16];
        SystemRandom::new()
            .fill(&mut identifier)
            .map_err(|_| RelayError::Unavailable)?;
        let now = Instant::now();
        let mut config = Rtc::builder()
            .set_crypto_provider(Arc::new(str0m::crypto::from_feature_flags()))
            .set_ice_lite(true)
            .clear_codecs()
            .set_send_buffer_audio(32)
            .set_send_buffer_video(512)
            .set_sctp_max_buffered_amount(16 * 1024);
        let mut payloads = vec![selected];
        if let Some(audio) = &audio {
            if payloads.iter().any(|video| {
                video.pt() == audio.payload.pt() || video.resend() == Some(audio.payload.pt())
            }) {
                return Err(RelayError::Invalid);
            }
            payloads.push(audio.payload);
        }
        *config.codec_config() = CodecConfig::new_from_payload_params(payloads);
        let rtc = config.build(now);
        let mut peer = Peer {
            id: URL_SAFE_NO_PAD.encode(identifier),
            role,
            rtc,
            mid: None,
            connected: false,
            failed: false,
            expires: now + PEER_LEASE,
            authorization_deadline: None,
            grant: None,
            deadline: now,
            payload: selected,
            audio,
            remote_ice,
            network: self.network.clone(),
        };
        let candidate = Candidate::host(
            socket.local_addr().map_err(|_| RelayError::Unavailable)?,
            "udp",
        )
        .map_err(|_| RelayError::Invalid)?;
        let _ = peer.rtc.add_local_candidate(candidate);
        // 每次修改Rtc后完整排出输出，避免示例外壳引入跨修改的隐藏顺序依赖。
        peer.deadline = drain(
            &mut peer,
            socket,
            &mut self.frames,
            &mut self.stats,
            &mut self.request_keyframe,
        )?;
        let answer = peer.rtc.sdp_api().accept_offer(offer).map_err(|error| {
            tracing::warn!(stage = "accept_offer", %error, "SDP协商被上游拒绝");
            RelayError::Invalid
        })?;
        if answer.media_lines.len() != if peer.audio.is_some() { 2 } else { 1 } {
            return Err(RelayError::Invalid);
        }
        for media in &answer.media_lines {
            if media.disabled || media.direction() != remote_direction.invert() {
                return Err(RelayError::Invalid);
            }
            if media.typ.to_string() == "audio" {
                let track = peer.audio.as_mut().ok_or(RelayError::Invalid)?;
                track.payload = audio::select(&media.rtp_params(), Some(track.payload))?;
                track.mid = media.mid();
            }
        }
        let media = answer
            .media_lines
            .iter()
            .find(|media| media.typ.to_string() == "video")
            .ok_or(RelayError::Invalid)?;
        let negotiated = video::select(&media.rtp_params(), Some(selected))?;
        peer.payload = negotiated;
        // MediaAdded在SRTP就绪后才发出，协商阶段从上游已解析的回答固定MID。
        peer.mid = Some(media.mid());
        peer.deadline = drain(
            &mut peer,
            socket,
            &mut self.frames,
            &mut self.stats,
            &mut self.request_keyframe,
        )?;
        Ok((peer, answer))
    }

    fn forward(&mut self, socket: &UdpSocket) {
        while let Some(data) = self.frames.pop() {
            let audio = data.params.spec().codec.is_audio();
            for peer in &mut self.peers {
                if peer.role != PeerRole::Subscriber || !peer.connected || peer.failed {
                    continue;
                }
                let mid = if audio {
                    peer.audio.as_ref().map(|track| track.mid)
                } else {
                    peer.mid
                };
                let Some(writer) = mid.and_then(|mid| peer.rtc.writer(mid)) else {
                    continue;
                };
                let Some(pt) = writer.match_params(data.params) else {
                    continue;
                };
                // data.data为Arc，复用同一编码帧；每条订阅连接仍独立加密和发送。
                if writer
                    .start_of_talkspurt(data.audio_start_of_talk_spurt)
                    .write(pt, data.network_time, data.time, data.data.clone())
                    .is_err()
                {
                    peer.failed = true;
                    continue;
                }
                if audio {
                    self.stats.audio_packets_forwarded += 1;
                    self.stats.audio_payload_bytes_forwarded += data.data.len() as u64;
                } else {
                    self.stats.encoded_frames_forwarded += 1;
                    self.stats.encoded_payload_bytes_forwarded += data.data.len() as u64;
                }
                match drain(
                    peer,
                    socket,
                    &mut self.frames,
                    &mut self.stats,
                    &mut self.request_keyframe,
                ) {
                    Ok(deadline) => peer.deadline = deadline,
                    Err(_) => peer.failed = true,
                }
            }
        }
        if self.request_keyframe
            && self
                .last_keyframe
                .is_none_or(|last| last.elapsed() >= Duration::from_secs(1))
            && let Some(peer) = self
                .peers
                .iter_mut()
                .find(|peer| peer.role == PeerRole::Publisher && !peer.failed)
            && let Some(mut writer) = peer.mid.and_then(|mid| peer.rtc.writer(mid))
        {
            let _ = writer.request_keyframe(None, KeyframeRequestKind::Pli);
            self.stats.keyframe_requests += 1;
            self.last_keyframe = Some(Instant::now());
            self.request_keyframe = false;
            match drain(
                peer,
                socket,
                &mut self.frames,
                &mut self.stats,
                &mut self.request_keyframe,
            ) {
                Ok(deadline) => peer.deadline = deadline,
                Err(_) => peer.failed = true,
            }
        }
    }
}

fn drain(
    peer: &mut Peer,
    socket: &UdpSocket,
    frames: &mut MediaQueues,
    stats: &mut RelayStats,
    request_keyframe: &mut bool,
) -> Result<Instant, RelayError> {
    for _ in 0..4096 {
        match peer.rtc.poll_output().map_err(|_| RelayError::Invalid)? {
            Output::Timeout(deadline) => return Ok(deadline),
            Output::Transmit(packet) => {
                // 收发共用固定策略，SDP不能把工作器变成任意UDP转发器。
                if peer.network.allows(packet.destination) {
                    match socket.send_to(&packet.contents, packet.destination) {
                        Ok(sent) => stats.outgoing_udp_payload_bytes += sent as u64,
                        // 共享UDP上的ICMP可能属于此前另一会话，不据此关闭当前会话或整个房间。
                        Err(error) if udp_feedback(&error) => stats.udp_feedback_errors += 1,
                        Err(_) => return Err(RelayError::Unavailable),
                    }
                } else {
                    stats.blocked_udp_payload_bytes += packet.contents.len() as u64;
                }
            }
            Output::Event(event) => match event {
                Event::Connected => {
                    peer.connected = true;
                    if peer.role == PeerRole::Subscriber {
                        *request_keyframe = true;
                    }
                }
                Event::MediaAdded(media) => {
                    let expected = if peer.role == PeerRole::Publisher {
                        Direction::RecvOnly
                    } else {
                        Direction::SendOnly
                    };
                    let matches = if media.kind == MediaKind::Video {
                        peer.mid == Some(media.mid)
                    } else if media.kind == MediaKind::Audio {
                        peer.audio
                            .as_ref()
                            .is_some_and(|track| track.mid == media.mid)
                    } else {
                        false
                    };
                    if !matches || media.direction != expected {
                        tracing::warn!(role = ?peer.role, direction = ?media.direction, "媒体方向不在实验范围");
                        return Err(RelayError::Invalid);
                    }
                }
                Event::MediaData(data) if peer.role == PeerRole::Publisher => {
                    let audio = data.params.spec().codec.is_audio();
                    let track = if audio {
                        peer.audio.as_ref().map(|track| (track.mid, track.payload))
                    } else {
                        peer.mid.map(|mid| (mid, peer.payload))
                    };
                    if !track.is_some_and(|(mid, payload)| {
                        mid == data.mid && payload.spec() == data.params.spec()
                    }) {
                        return Err(RelayError::Invalid);
                    }
                    if audio {
                        stats.audio_packets_received += 1;
                    } else {
                        stats.encoded_frames_received += 1;
                    }
                    if !audio && !data.contiguous {
                        *request_keyframe = true;
                    }
                    if !frames.push(data, stats) && !audio {
                        *request_keyframe = true;
                    }
                }
                Event::KeyframeRequest(request)
                    if peer.role == PeerRole::Subscriber && peer.mid == Some(request.mid) =>
                {
                    *request_keyframe = true
                }
                _ => {}
            },
        }
    }
    // 无法完整排空时丢弃该会话，不对尚未排空的Rtc继续修改。
    Err(RelayError::Busy)
}

struct RoomSlot {
    room: Room,
    rx: Receiver<Command>,
    shared: Arc<Mutex<RelayStats>>,
}

fn run(
    socket: UdpSocket,
    mut rooms: Vec<RoomSlot>,
    stop: Arc<AtomicBool>,
    worker_shared: Arc<Mutex<WorkerStats>>,
    network: network::MediaNetwork,
) -> io::Result<()> {
    let destination = socket.local_addr()?;
    let mut worker_stats = WorkerStats {
        worker_alive: true,
        room_slots: rooms.len(),
        udp_port: destination.port(),
        ..Default::default()
    };
    let mut buffer = [0_u8; 65_536];
    let mut first = 0;
    while !stop.load(Ordering::Acquire) {
        if let Ok(mut value) = worker_shared.lock() {
            *value = worker_stats.clone();
        }
        let at = Instant::now();
        let wall = SystemTime::now().duration_since(UNIX_EPOCH).ok();
        let count = rooms.len();
        let mut handled_command = false;
        // 房间各有4条命令槽；每轮每房间只取一条并轮换起点，热房间不能占用其他房间队列。
        for offset in 0..count {
            let slot = &mut rooms[(first + offset) % count];
            let room = &mut slot.room;
            let wall = room.revoked.observe(wall);
            room.expire(at, wall);
            if let Ok(command) = slot.rx.try_recv() {
                handled_command = true;
                room.command(command, &socket);
            }
            room.forward(&socket);
            for peer in &mut room.peers {
                if peer.failed || peer.deadline > Instant::now() {
                    continue;
                }
                if peer
                    .rtc
                    .handle_input(Input::Timeout(Instant::now()))
                    .is_err()
                {
                    peer.failed = true;
                    continue;
                }
                match drain(
                    peer,
                    &socket,
                    &mut room.frames,
                    &mut room.stats,
                    &mut room.request_keyframe,
                ) {
                    Ok(deadline) => peer.deadline = deadline,
                    Err(_) => peer.failed = true,
                }
            }
            room.forward(&socket);
            room.publish_stats(&slot.shared);
        }
        first = (first + 1) % count;
        // 消费完已有命令后才能休眠；unpark令牌覆盖检查与休眠之间到达的新命令。
        if rooms.iter().all(|slot| slot.room.peers.is_empty()) {
            if !handled_command {
                thread::park_timeout(Duration::from_millis(50));
            }
            continue;
        }
        let deadline = rooms
            .iter()
            .flat_map(|slot| &slot.room.peers)
            .filter(|peer| !peer.failed)
            .map(|peer| peer.deadline)
            .min()
            .unwrap_or_else(Instant::now);
        let wait = deadline
            .saturating_duration_since(Instant::now())
            .clamp(Duration::from_millis(1), Duration::from_millis(10));
        socket.set_read_timeout(Some(wait))?;
        match socket.recv_from(&mut buffer) {
            Ok((length, source)) if network.allows(source) => {
                worker_stats.incoming_udp_payload_bytes += length as u64;
                if length > 2000 {
                    worker_stats.oversize_udp_packets += 1;
                    worker_stats.unassigned_udp_payload_bytes += length as u64;
                    continue;
                }
                let Ok(contents) = buffer[..length].try_into() else {
                    worker_stats.unassigned_udp_payload_bytes += length as u64;
                    continue;
                };
                let input = Input::Receive(
                    Instant::now(),
                    Receive {
                        proto: Protocol::Udp,
                        source,
                        destination,
                        contents,
                    },
                );
                // 先由str0m匹配ICE/DTLS会话，再归属房间；未知UDP不计入任何租户。
                let mut matched = false;
                for slot in &mut rooms {
                    let room = &mut slot.room;
                    let Some(peer) = room
                        .peers
                        .iter_mut()
                        .find(|peer| !peer.failed && peer.rtc.accepts(&input))
                    else {
                        continue;
                    };
                    room.stats.incoming_udp_payload_bytes += length as u64;
                    matched = true;
                    if peer.rtc.handle_input(input).is_err() {
                        peer.failed = true;
                        room.stats.protocol_errors += 1;
                        break;
                    }
                    match drain(
                        peer,
                        &socket,
                        &mut room.frames,
                        &mut room.stats,
                        &mut room.request_keyframe,
                    ) {
                        Ok(deadline) => peer.deadline = deadline,
                        Err(_) => {
                            peer.failed = true;
                            room.stats.protocol_errors += 1;
                        }
                    }
                    break;
                }
                if !matched {
                    worker_stats.unassigned_udp_payload_bytes += length as u64;
                }
            }
            Ok((length, _)) => worker_stats.blocked_udp_payload_bytes += length as u64,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) => {}
            // 共享socket上的ICMP不能可靠归属房间，不能据此关闭任一会话。
            Err(error) if udp_feedback(&error) => worker_stats.udp_feedback_errors += 1,
            Err(error) => return Err(error),
        }
    }
    for slot in &mut rooms {
        slot.room.stats.removed_sessions += slot.room.peers.len() as u64;
        slot.room.peers.clear();
        slot.room.frames.clear();
        slot.room.publish_stats(&slot.shared);
    }
    if let Ok(mut value) = worker_shared.lock() {
        *value = worker_stats;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::revocation::MAX_REVOKED_TOKENS;

    fn offer(direction: Direction) -> SdpOffer {
        let _ = tracing_subscriber::fmt()
            .with_test_writer()
            .with_max_level(tracing::Level::WARN)
            .try_init();
        let mut rtc = Rtc::builder()
            .set_crypto_provider(Arc::new(str0m::crypto::from_feature_flags()))
            .clear_codecs()
            .enable_vp8(true)
            .build(Instant::now());
        let mut changes = rtc.sdp_api();
        changes.add_media(MediaKind::Video, direction, None, None, None);
        let (offer, _) = changes.apply().unwrap();
        while !matches!(rtc.poll_output().unwrap(), Output::Timeout(_)) {}
        offer
    }

    async fn wait_peers(relay: &Relay, expected: usize) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while relay.stats().unwrap().active_peers != expected {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }

    fn grant(revision: Option<u64>) -> SessionGrant {
        SessionGrant {
            subject: "alice".into(),
            expires_unix_seconds: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs()
                + 120,
            assignment_revision: revision,
            token_digest: [7; 32],
        }
    }

    fn scoped_grant(subject: &str, digest: u8) -> SessionGrant {
        SessionGrant {
            subject: subject.into(),
            token_digest: [digest; 32],
            ..grant(Some(3))
        }
    }

    #[tokio::test]
    async fn trickle_commands_keep_lease_owner_fence_revocation_and_cancel_boundaries() {
        let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
        let mut room = Room::new(socket.local_addr().unwrap().port(), true);
        room.stats.assignment_revision = Some(3);
        let offer = offer(Direction::SendOnly);
        let media = &offer.media_lines[0];
        let credentials = media
            .ice_creds()
            .or_else(|| offer.session.ice_creds())
            .unwrap();
        let fragment = format!(
            "a=ice-ufrag:{}\r\na=ice-pwd:{}\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:{}\r\na=candidate:1 1 UDP 2130706431 127.0.0.1 32000 typ host\r\n",
            credentials.ufrag,
            credentials.pass,
            media.mid()
        );
        let grant = scoped_grant("alice", 1);
        let (reply, receive) = oneshot::channel();
        room.command(
            Command::Offer(PeerRole::Publisher, offer, Some(grant.clone()), reply),
            &socket,
        );
        let session = receive.await.unwrap().unwrap();
        let deadline = room.peers[0].expires;
        let command = |grant: SessionGrant, text: &str| {
            let (reply, receive) = oneshot::channel();
            (
                Command::Trickle(
                    session.id.clone(),
                    PeerRole::Publisher,
                    Some(grant),
                    format!("\"{}\"", session.id),
                    ice::IceFragment::parse(text).unwrap(),
                    reply,
                ),
                receive,
            )
        };
        for expected in [1, 0] {
            let (request, response) = command(grant.clone(), &fragment);
            room.command(request, &socket);
            assert_eq!(response.await.unwrap().unwrap(), expected);
            assert_eq!(room.peers[0].expires, deadline);
        }
        let (request, response) = command(scoped_grant("bob", 2), &fragment);
        room.command(request, &socket);
        assert!(matches!(response.await.unwrap(), Err(RelayError::NotFound)));
        let (request, response) = command(
            SessionGrant {
                assignment_revision: Some(4),
                ..grant.clone()
            },
            &fragment,
        );
        room.command(request, &socket);
        assert!(matches!(response.await.unwrap(), Err(RelayError::Conflict)));
        let (request, response) = command(grant.clone(), &fragment.replace("32000", "32001"));
        drop(response);
        room.command(request, &socket);
        assert_eq!(room.peers[0].remote_ice.seen_count_for_test(), 1);
        let (reply, receive) = oneshot::channel();
        room.command(Command::Revoke(3, grant.clone(), reply), &socket);
        receive.await.unwrap().unwrap();
        let (request, response) = command(grant, &fragment);
        room.command(request, &socket);
        assert!(matches!(response.await.unwrap(), Err(RelayError::Denied)));
        assert!(room.peers.is_empty());
    }

    #[tokio::test]
    async fn bounded_rooms_share_socket_but_preserve_peers_revocations_and_drain_floors() {
        assert!(Relay::start_rooms(0, true).is_err());
        assert!(Relay::start_rooms(MAX_ROOMS + 1, true).is_err());
        let (rooms, worker) = Relay::start_rooms(MAX_ROOMS, true).unwrap();
        let port = rooms[0].stats().unwrap().udp_port;
        for room in &rooms {
            assert_eq!(room.stats().unwrap().udp_port, port);
            room.activate(3).await.unwrap();
        }
        let a = &rooms[0];
        let b = &rooms[1];
        let publisher = a
            .offer_authorized(
                PeerRole::Publisher,
                offer(Direction::SendOnly),
                grant(Some(3)),
            )
            .await
            .unwrap();
        let other = b
            .offer_authorized(
                PeerRole::Publisher,
                offer(Direction::SendOnly),
                grant(Some(3)),
            )
            .await
            .unwrap();
        assert!(!b.remove(&publisher.id).await.unwrap());
        a.revoke(3, grant(Some(3))).await.unwrap();
        wait_peers(a, 0).await;
        assert!(b.exists(&other.id, PeerRole::Publisher).await.unwrap());
        a.drain_room(3).await.unwrap();
        assert!(matches!(a.activate(3).await, Err(RelayError::Conflict)));
        a.activate(5).await.unwrap();
        assert!(matches!(a.drain_room(3).await, Err(RelayError::Conflict)));
        assert!(b.exists(&other.id, PeerRole::Publisher).await.unwrap());
        b.remove(&other.id).await.unwrap();
        a.drain_room(5).await.unwrap();
        assert!(matches!(a.activate(5).await, Err(RelayError::Conflict)));
        worker.shutdown().unwrap();
        assert!(rooms.iter().all(|room| !room.stats().unwrap().worker_alive));
    }

    #[tokio::test]
    async fn optional_opus_tracks_preserve_video_only_admission_and_reject_unsupported_shapes() {
        fn media_offer(kinds: &[MediaKind], direction: Direction, audio_pt: u8) -> SdpOffer {
            let mut config = Rtc::builder()
                .set_crypto_provider(Arc::new(str0m::crypto::from_feature_flags()))
                .clear_codecs()
                .enable_vp8(true)
                .enable_opus(true, false);
            let params: Vec<_> = config
                .codec_config()
                .params()
                .iter()
                .map(|param| {
                    if param.spec().codec == str0m::format::Codec::Opus {
                        PayloadParams::new(audio_pt.into(), None, param.spec())
                    } else {
                        *param
                    }
                })
                .collect();
            *config.codec_config() = CodecConfig::new_from_payload_params(params);
            let mut rtc = config.build(Instant::now());
            let mut changes = rtc.sdp_api();
            for kind in kinds {
                changes.add_media(*kind, direction, None, None, None);
            }
            let (offer, _) = changes.apply().unwrap();
            while !matches!(rtc.poll_output().unwrap(), Output::Timeout(_)) {}
            offer
        }
        let (relay, worker) = Relay::start().unwrap();
        for kinds in [
            vec![MediaKind::Audio],
            vec![MediaKind::Video, MediaKind::Video],
            vec![MediaKind::Video, MediaKind::Audio, MediaKind::Audio],
        ] {
            assert!(matches!(
                relay
                    .offer(
                        PeerRole::Publisher,
                        media_offer(&kinds, Direction::SendOnly, 111)
                    )
                    .await,
                Err(RelayError::Invalid)
            ));
        }
        let publisher = relay
            .offer(PeerRole::Publisher, offer(Direction::SendOnly))
            .await
            .unwrap();
        assert!(matches!(
            relay
                .offer(
                    PeerRole::Subscriber,
                    media_offer(
                        &[MediaKind::Video, MediaKind::Audio],
                        Direction::RecvOnly,
                        112
                    )
                )
                .await,
            Err(RelayError::Conflict)
        ));
        relay.remove(&publisher.id).await.unwrap();
        let publisher = relay
            .offer(
                PeerRole::Publisher,
                media_offer(
                    &[MediaKind::Audio, MediaKind::Video],
                    Direction::SendRecv,
                    111,
                ),
            )
            .await
            .unwrap();
        assert_eq!(publisher.answer.media_lines.len(), 2);
        assert!(
            publisher
                .answer
                .media_lines
                .iter()
                .all(|media| media.direction() == Direction::RecvOnly)
        );
        let subscriber = relay
            .offer(
                PeerRole::Subscriber,
                media_offer(
                    &[MediaKind::Video, MediaKind::Audio],
                    Direction::RecvOnly,
                    112,
                ),
            )
            .await
            .unwrap();
        assert_eq!(subscriber.answer.media_lines.len(), 2);
        let audio = subscriber
            .answer
            .media_lines
            .iter()
            .find(|media| media.typ.to_string() == "audio")
            .unwrap();
        assert_eq!(*audio.rtp_params()[0].pt(), 112);
        relay
            .offer(PeerRole::Subscriber, offer(Direction::RecvOnly))
            .await
            .unwrap();
        wait_peers(&relay, 3).await;
        assert_eq!(
            relay.stats().unwrap().active_audio_codec.as_deref(),
            Some("opus")
        );
        relay.remove(&publisher.id).await.unwrap();
        wait_peers(&relay, 0).await;
        assert_eq!(relay.stats().unwrap().active_audio_codec, None);
        worker.shutdown().unwrap();
    }

    #[tokio::test]
    async fn h264_admission_pins_source_parameters_maps_payloads_and_keeps_capacity_after_rejection()
     {
        fn configured_offer(direction: Direction, codecs: CodecConfig) -> SdpOffer {
            let mut config = Rtc::builder()
                .set_crypto_provider(Arc::new(str0m::crypto::from_feature_flags()))
                .clear_codecs();
            *config.codec_config() = codecs;
            let mut rtc = config.build(Instant::now());
            let mut changes = rtc.sdp_api();
            changes.add_media(MediaKind::Video, direction, None, None, None);
            let (offer, _) = changes.apply().unwrap();
            while !matches!(rtc.poll_output().unwrap(), Output::Timeout(_)) {}
            offer
        }
        fn h264(profile: u32, mode: bool, pt: u8) -> CodecConfig {
            let mut config = CodecConfig::empty();
            config.add_h264(pt.into(), Some((pt + 1).into()), mode, profile);
            config
        }
        let (relay, worker) = Relay::start().unwrap();
        assert!(matches!(
            relay
                .offer(
                    PeerRole::Publisher,
                    configured_offer(Direction::SendOnly, h264(0x64001f, true, 108))
                )
                .await,
            Err(RelayError::Invalid)
        ));
        let publisher = relay
            .offer(
                PeerRole::Publisher,
                configured_offer(Direction::SendOnly, h264(0x42e01f, true, 108)),
            )
            .await
            .unwrap();
        for config in [
            h264(0x64001f, true, 102),
            h264(0x42e01e, true, 102),
            h264(0x42e01f, false, 102),
            {
                let mut config = CodecConfig::empty();
                config.enable_vp8(true);
                config
            },
        ] {
            assert!(matches!(
                relay
                    .offer(
                        PeerRole::Subscriber,
                        configured_offer(Direction::RecvOnly, config)
                    )
                    .await,
                Err(RelayError::Conflict)
            ));
        }
        let mut mixed = h264(0x42e01f, true, 102);
        mixed.enable_vp8(true);
        let viewer = relay
            .offer(
                PeerRole::Subscriber,
                configured_offer(Direction::RecvOnly, mixed),
            )
            .await
            .unwrap();
        let params = viewer.answer.media_lines[0].rtp_params();
        assert_eq!(params.len(), 1);
        assert_eq!(params[0].spec().codec, str0m::format::Codec::H264);
        assert_eq!(*params[0].pt(), 102);
        assert_eq!(*publisher.answer.media_lines[0].rtp_params()[0].pt(), 108);
        wait_peers(&relay, 2).await;
        assert_eq!(relay.stats().unwrap().accepted_sessions, 2);
        assert_eq!(
            relay.stats().unwrap().active_video_codec.as_deref(),
            Some("h264")
        );
        relay.remove(&publisher.id).await.unwrap();
        wait_peers(&relay, 0).await;
        relay
            .offer(PeerRole::Publisher, offer(Direction::SendOnly))
            .await
            .unwrap();
        wait_peers(&relay, 1).await;
        assert_eq!(
            relay.stats().unwrap().active_video_codec.as_deref(),
            Some("vp8")
        );
        worker.shutdown().unwrap();
    }

    #[tokio::test]
    async fn reclaimed_revocation_still_denies_preverified_commands_after_wall_clock_rollback() {
        let mut room = Room {
            network: network::MediaNetwork::Loopback,
            peers: Vec::new(),
            frames: MediaQueues::default(),
            request_keyframe: false,
            last_keyframe: None,
            revoked: Revocations::default(),
            stats: RelayStats {
                assignment_required: true,
                assignment_revision: Some(3),
                ..Default::default()
            },
        };
        let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
        let old = scoped_grant("alice", 1);
        room.revoked
            .observe(SystemTime::now().duration_since(UNIX_EPOCH).ok());
        room.revoked.insert(&old).unwrap();
        let floor = Duration::from_secs(old.expires_unix_seconds + 1);
        room.revoked.observe(Some(floor));
        assert_eq!(room.revoked.len(), 0);
        for command_kind in 0..5 {
            if command_kind == 0 {
                let (tx, rx) = oneshot::channel();
                room.command(
                    Command::Offer(
                        PeerRole::Publisher,
                        offer(Direction::SendOnly),
                        Some(old.clone()),
                        tx,
                    ),
                    &socket,
                );
                assert!(matches!(rx.await.unwrap(), Err(RelayError::Denied)));
            } else if command_kind == 1 {
                let (tx, rx) = oneshot::channel();
                room.command(
                    Command::Renew("old".into(), PeerRole::Publisher, old.clone(), tx),
                    &socket,
                );
                assert!(matches!(rx.await.unwrap(), Err(RelayError::Denied)));
            } else if command_kind == 2 {
                let (tx, rx) = oneshot::channel();
                room.command(
                    Command::Exists("old".into(), PeerRole::Publisher, Some(old.clone()), tx),
                    &socket,
                );
                assert!(matches!(rx.await.unwrap(), Err(RelayError::Denied)));
            } else if command_kind == 3 {
                let (tx, rx) = oneshot::channel();
                room.command(
                    Command::Remove(
                        "old".into(),
                        Some(PeerRole::Publisher),
                        Some(old.clone()),
                        tx,
                    ),
                    &socket,
                );
                assert!(matches!(rx.await.unwrap(), Err(RelayError::Denied)));
            } else {
                let (tx, rx) = oneshot::channel();
                room.command(Command::Revoke(3, old.clone(), tx), &socket);
                assert!(matches!(rx.await.unwrap(), Err(RelayError::Denied)));
            }
        }
        let fresh = SessionGrant {
            expires_unix_seconds: old.expires_unix_seconds + 120,
            token_digest: [2; 32],
            ..old
        };
        let (tx, rx) = oneshot::channel();
        room.command(
            Command::Offer(
                PeerRole::Publisher,
                offer(Direction::SendOnly),
                Some(fresh),
                tx,
            ),
            &socket,
        );
        assert!(rx.await.unwrap().is_ok());
        assert_eq!(room.peers.len(), 1);
        assert_eq!(room.revoked.watermark_seconds(), Some(floor.as_secs()));
    }

    #[tokio::test]
    async fn token_revocation_stops_matching_media_and_blocks_all_replay_paths() {
        let (relay, worker) = Relay::start_guarded().unwrap();
        relay.activate(3).await.unwrap();
        let alice = scoped_grant("alice", 1);
        let bob = scoped_grant("bob", 2);
        let carol = scoped_grant("carol", 3);
        let publisher = relay
            .offer_authorized(
                PeerRole::Publisher,
                offer(Direction::SendOnly),
                alice.clone(),
            )
            .await
            .unwrap();
        let viewer = relay
            .offer_authorized(
                PeerRole::Subscriber,
                offer(Direction::RecvOnly),
                bob.clone(),
            )
            .await
            .unwrap();
        let survivor = relay
            .offer_authorized(
                PeerRole::Subscriber,
                offer(Direction::RecvOnly),
                carol.clone(),
            )
            .await
            .unwrap();
        assert!(matches!(
            relay.revoke(2, bob.clone()).await,
            Err(RelayError::Conflict)
        ));
        let receipt = relay.revoke(3, bob.clone()).await.unwrap();
        assert_eq!(receipt.removed_sessions, 1);
        assert_eq!(
            relay.revoke(3, bob.clone()).await.unwrap().removed_sessions,
            0
        );
        assert!(matches!(
            relay
                .renew(&viewer.id, PeerRole::Subscriber, bob.clone())
                .await,
            Err(RelayError::Denied)
        ));
        assert!(matches!(
            relay
                .exists_owned(&viewer.id, PeerRole::Subscriber, bob.clone())
                .await,
            Err(RelayError::Denied)
        ));
        assert!(matches!(
            relay
                .remove_owned(&survivor.id, PeerRole::Subscriber, bob.clone())
                .await,
            Err(RelayError::Denied)
        ));
        assert!(matches!(
            relay
                .offer_authorized(PeerRole::Subscriber, offer(Direction::RecvOnly), bob)
                .await,
            Err(RelayError::Denied)
        ));
        assert!(
            relay
                .exists_owned(&survivor.id, PeerRole::Subscriber, carol)
                .await
                .unwrap()
        );
        assert!(
            relay
                .exists_owned(&publisher.id, PeerRole::Publisher, alice.clone())
                .await
                .unwrap()
        );
        assert_eq!(
            relay
                .revoke(3, alice.clone())
                .await
                .unwrap()
                .removed_sessions,
            2
        );
        wait_peers(&relay, 0).await;
        assert!(matches!(
            relay
                .offer_authorized(PeerRole::Publisher, offer(Direction::SendOnly), alice)
                .await,
            Err(RelayError::Denied)
        ));
        worker.shutdown().unwrap();
    }

    #[tokio::test]
    async fn revoking_an_old_token_does_not_revoke_a_session_already_renewed_with_another_token() {
        let (relay, worker) = Relay::start_guarded().unwrap();
        relay.activate(3).await.unwrap();
        let original = scoped_grant("alice", 1);
        let publisher = relay
            .offer_authorized(
                PeerRole::Publisher,
                offer(Direction::SendOnly),
                original.clone(),
            )
            .await
            .unwrap();
        let fresh = SessionGrant {
            token_digest: [2; 32],
            expires_unix_seconds: original.expires_unix_seconds + 30,
            ..original.clone()
        };
        relay
            .renew(&publisher.id, PeerRole::Publisher, fresh.clone())
            .await
            .unwrap();
        assert_eq!(relay.revoke(3, original).await.unwrap().removed_sessions, 0);
        assert!(
            relay
                .exists_owned(&publisher.id, PeerRole::Publisher, fresh.clone())
                .await
                .unwrap()
        );
        assert_eq!(relay.revoke(3, fresh).await.unwrap().removed_sessions, 1);
        worker.shutdown().unwrap();
    }

    #[tokio::test]
    async fn revocation_capacity_never_evicts_unexpired_denials_and_drain_fences_old_versions() {
        let (relay, worker) = Relay::start_guarded().unwrap();
        relay.activate(3).await.unwrap();
        for digest in 0..MAX_REVOKED_TOKENS as u8 {
            assert_eq!(
                relay
                    .revoke(3, scoped_grant("alice", digest))
                    .await
                    .unwrap()
                    .revoked_tokens,
                digest as usize + 1
            );
        }
        assert!(matches!(
            relay.revoke(3, scoped_grant("alice", 255)).await,
            Err(RelayError::Busy)
        ));
        assert_eq!(
            relay
                .revoke(3, scoped_grant("alice", 0))
                .await
                .unwrap()
                .revoked_tokens,
            64
        );
        assert_eq!(relay.activate(3).await.unwrap(), 0);
        assert!(matches!(
            relay
                .offer_authorized(
                    PeerRole::Publisher,
                    offer(Direction::SendOnly),
                    scoped_grant("alice", 0)
                )
                .await,
            Err(RelayError::Denied)
        ));
        relay.drain_room(3).await.unwrap();
        relay.activate(7).await.unwrap();
        assert!(matches!(
            relay.revoke(3, scoped_grant("alice", 0)).await,
            Err(RelayError::Conflict)
        ));
        assert!(matches!(
            relay
                .offer_authorized(
                    PeerRole::Publisher,
                    offer(Direction::SendOnly),
                    scoped_grant("alice", 0)
                )
                .await,
            Err(RelayError::Conflict)
        ));
        let next = SessionGrant {
            assignment_revision: Some(7),
            ..scoped_grant("alice", 255)
        };
        assert_eq!(relay.revoke(7, next).await.unwrap().revoked_tokens, 1);
        worker.shutdown().unwrap();
    }

    #[test]
    fn renewal_replay_and_clock_rollback_cannot_move_the_original_authorization_cap() {
        let at = Instant::now();
        let wall = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
        let mut room = Room {
            network: network::MediaNetwork::Loopback,
            peers: Vec::new(),
            frames: MediaQueues::default(),
            request_keyframe: false,
            last_keyframe: None,
            stats: RelayStats::default(),
            revoked: Revocations::default(),
        };
        let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
        let (mut peer, _) = room
            .negotiate(PeerRole::Publisher, offer(Direction::SendOnly), &socket)
            .unwrap();
        let original = SessionGrant {
            subject: "alice".into(),
            expires_unix_seconds: wall.as_secs() + 120,
            assignment_revision: Some(3),
            token_digest: [7; 32],
        };
        peer.grant = Some(original.clone());
        let cap = at + Duration::from_secs(120);
        peer.authorization_deadline = Some(cap);
        peer.expires = at + PEER_LEASE;
        let newer = SessionGrant {
            expires_unix_seconds: original.expires_unix_seconds + 30,
            ..original.clone()
        };
        let renewed = peer
            .renew(
                newer.clone(),
                at + Duration::from_secs(30),
                wall - Duration::from_secs(100),
            )
            .unwrap();
        assert_eq!(renewed.lease_milliseconds, 60000);
        assert_eq!(
            peer.authorization_deadline,
            Some(cap + Duration::from_secs(30))
        );
        let expiry = peer.expires;
        let retry = peer
            .renew(
                newer,
                at + Duration::from_secs(50),
                wall + Duration::from_secs(50),
            )
            .unwrap();
        assert_eq!(retry.lease_milliseconds, 40000);
        assert_eq!(peer.expires, expiry);
        assert!(matches!(
            peer.renew(original.clone(), at + Duration::from_secs(51), wall),
            Err(RelayError::Conflict)
        ));
        let fresh = SessionGrant {
            expires_unix_seconds: original.expires_unix_seconds + 60,
            ..original
        };
        assert!(matches!(
            peer.renew(fresh, expiry, wall + Duration::from_secs(90)),
            Err(RelayError::NotFound)
        ));
    }

    #[tokio::test]
    async fn renewal_requires_owner_role_and_revision_and_cannot_cross_a_drain() {
        let (relay, worker) = Relay::start_guarded().unwrap();
        relay.activate(3).await.unwrap();
        let original = grant(Some(3));
        let publisher = relay
            .offer_authorized(
                PeerRole::Publisher,
                offer(Direction::SendOnly),
                original.clone(),
            )
            .await
            .unwrap();
        let newer = SessionGrant {
            expires_unix_seconds: original.expires_unix_seconds + 30,
            ..original
        };
        for (role, subject, revision, conflict) in [
            (PeerRole::Publisher, "bob", Some(3), false),
            (PeerRole::Subscriber, "alice", Some(3), false),
            (PeerRole::Publisher, "alice", None, true),
            (PeerRole::Publisher, "alice", Some(4), true),
        ] {
            let changed = SessionGrant {
                subject: subject.into(),
                assignment_revision: revision,
                ..newer.clone()
            };
            let result = relay.renew(&publisher.id, role, changed).await;
            assert!(if conflict {
                matches!(result, Err(RelayError::Conflict))
            } else {
                matches!(result, Err(RelayError::NotFound))
            });
        }
        relay
            .renew(&publisher.id, PeerRole::Publisher, newer.clone())
            .await
            .unwrap();
        assert_eq!(relay.stats().unwrap().accepted_sessions, 1);
        relay.drain_room(3).await.unwrap();
        assert!(matches!(
            relay
                .renew(&publisher.id, PeerRole::Publisher, newer.clone())
                .await,
            Err(RelayError::Conflict)
        ));
        relay.activate(7).await.unwrap();
        let next = SessionGrant {
            assignment_revision: Some(7),
            ..newer
        };
        assert!(matches!(
            relay.renew(&publisher.id, PeerRole::Publisher, next).await,
            Err(RelayError::NotFound)
        ));
        worker.shutdown().unwrap();
    }

    #[tokio::test]
    async fn guarded_room_starts_closed_and_drain_irreversibly_fences_old_revision() {
        let (relay, worker) = Relay::start_guarded().unwrap();
        assert!(matches!(
            relay
                .offer_authorized(
                    PeerRole::Publisher,
                    offer(Direction::SendOnly),
                    grant(Some(3))
                )
                .await,
            Err(RelayError::Conflict)
        ));
        assert_eq!(relay.activate(3).await.unwrap(), 0);
        for revision in [None, Some(2), Some(4)] {
            assert!(matches!(
                relay
                    .offer_authorized(
                        PeerRole::Publisher,
                        offer(Direction::SendOnly),
                        grant(revision)
                    )
                    .await,
                Err(RelayError::Conflict)
            ));
        }
        relay
            .offer_authorized(
                PeerRole::Publisher,
                offer(Direction::SendOnly),
                grant(Some(3)),
            )
            .await
            .unwrap();
        relay
            .offer_authorized(
                PeerRole::Subscriber,
                offer(Direction::RecvOnly),
                grant(Some(3)),
            )
            .await
            .unwrap();
        assert_eq!(relay.drain_room(3).await.unwrap(), 0);
        assert_eq!(relay.drain_room(3).await.unwrap(), 0);
        assert!(matches!(relay.activate(3).await, Err(RelayError::Conflict)));
        assert!(matches!(
            relay
                .offer_authorized(
                    PeerRole::Publisher,
                    offer(Direction::SendOnly),
                    grant(Some(3))
                )
                .await,
            Err(RelayError::Conflict)
        ));
        assert_eq!(relay.activate(7).await.unwrap(), 0);
        relay
            .offer_authorized(
                PeerRole::Publisher,
                offer(Direction::SendOnly),
                grant(Some(7)),
            )
            .await
            .unwrap();
        assert!(matches!(
            relay.drain_room(3).await,
            Err(RelayError::Conflict)
        ));
        wait_peers(&relay, 1).await;
        assert_eq!(relay.stats().unwrap().accepted_sessions, 3);
        assert_eq!(relay.stats().unwrap().removed_sessions, 2);
        worker.shutdown().unwrap();
    }

    #[tokio::test]
    async fn one_publisher_two_subscriber_capacity_and_room_teardown_are_enforced() {
        let (relay, worker) = Relay::start().unwrap();
        assert!(matches!(
            relay
                .offer(PeerRole::Subscriber, offer(Direction::RecvOnly))
                .await,
            Err(RelayError::Conflict)
        ));
        let publisher = relay
            .offer(PeerRole::Publisher, offer(Direction::SendOnly))
            .await
            .unwrap();
        assert!(matches!(
            relay
                .offer(PeerRole::Publisher, offer(Direction::SendOnly))
                .await,
            Err(RelayError::Conflict)
        ));
        let first = relay
            .offer(PeerRole::Subscriber, offer(Direction::RecvOnly))
            .await
            .unwrap();
        let second = relay
            .offer(PeerRole::Subscriber, offer(Direction::RecvOnly))
            .await
            .unwrap();
        assert!(matches!(
            relay
                .offer(PeerRole::Subscriber, offer(Direction::RecvOnly))
                .await,
            Err(RelayError::Busy)
        ));
        wait_peers(&relay, 3).await;
        assert!(relay.remove(&first.id).await.unwrap());
        wait_peers(&relay, 2).await;
        let replacement = relay
            .offer(PeerRole::Subscriber, offer(Direction::RecvOnly))
            .await
            .unwrap();
        assert_ne!(replacement.id, second.id);
        assert!(relay.remove(&publisher.id).await.unwrap());
        wait_peers(&relay, 0).await;
        assert!(!relay.remove(&second.id).await.unwrap());
        assert_eq!(relay.stats().unwrap().accepted_sessions, 4);
        worker.shutdown().unwrap();
    }

    #[tokio::test]
    async fn invalid_direction_does_not_reserve_a_slot_or_poison_the_next_offer() {
        let (relay, worker) = Relay::start().unwrap();
        assert!(matches!(
            relay
                .offer(PeerRole::Publisher, offer(Direction::RecvOnly))
                .await,
            Err(RelayError::Invalid)
        ));
        assert_eq!(relay.stats().unwrap().active_peers, 0);
        let valid = relay
            .offer(PeerRole::Publisher, offer(Direction::SendOnly))
            .await
            .unwrap();
        assert!(relay.remove(&valid.id).await.unwrap());
        wait_peers(&relay, 0).await;
        worker.shutdown().unwrap();
    }

    #[tokio::test]
    async fn malformed_and_oversize_udp_do_not_stop_room_control_or_socket_recovery() {
        let (relay, worker) = Relay::start().unwrap();
        let port = relay.stats().unwrap().udp_port;
        let publisher = relay
            .offer(PeerRole::Publisher, offer(Direction::SendOnly))
            .await
            .unwrap();
        let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
        sender.send_to(&[0_u8; 4096], ("127.0.0.1", port)).unwrap();
        sender
            .send_to(b"invalid-datagram", ("127.0.0.1", port))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while relay.worker_stats().unwrap().oversize_udp_packets == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(relay.worker_stats().unwrap().unassigned_udp_payload_bytes >= 4096);
        assert_eq!(relay.stats().unwrap().incoming_udp_payload_bytes, 0);
        assert!(relay.remove(&publisher.id).await.unwrap());
        wait_peers(&relay, 0).await;
        worker.shutdown().unwrap();
        assert!(UdpSocket::bind(("127.0.0.1", port)).is_ok());
    }

    #[tokio::test]
    async fn stopped_worker_is_unavailable_instead_of_a_full_control_queue() {
        let (relay, worker) = Relay::start().unwrap();
        worker.shutdown().unwrap();
        assert!(!relay.stats().unwrap().worker_alive);
        assert!(matches!(
            relay
                .offer(PeerRole::Publisher, offer(Direction::SendOnly))
                .await,
            Err(RelayError::Unavailable)
        ));
    }
}

use std::{
    collections::{BTreeMap, BTreeSet},
    io::{BufRead, Read},
    net::SocketAddr,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use rcgen::{
    BasicConstraints, Certificate, CertificateParams, ExtendedKeyUsagePurpose, IsCa, Issuer,
    KeyPair, KeyUsagePurpose, PublicKeyData,
};
use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use vs_coordination::{
    NodeId,
    media_admin::{MaintenanceOutcome, MaintenanceView, MediaAdmin, MediaAdminConfig},
    media_registry::{AuthorityCommand, AuthorityReply, MediaNodeCommand, apply_authority},
    storage::StateData,
    tls::{POLICY_MODE, TlsSettings, TlsTransport, fingerprint},
};

const TOKEN: &str = "mtls-coordination-test-only-service-token";
const CONTROL_TOKEN: &str = "private-media-control-test-token-with-32-bytes";
const PROFILE_ISSUER: &str = "https://synthetic-profile.example";
const PROFILE_AUDIENCE: &str = "profile-consensus";

struct Pki {
    ca: Certificate,
    issuer: Issuer<'static, KeyPair>,
}
struct Identity {
    cert: Certificate,
    cert_pem: String,
    key_pem: String,
    public_key_der: Vec<u8>,
}
struct Fixture {
    directory: tempfile::TempDir,
    pki: Pki,
    nodes: BTreeMap<NodeId, Identity>,
    operator: Identity,
    unknown: Identity,
    peers: BTreeMap<NodeId, SocketAddr>,
    names: BTreeMap<NodeId, String>,
}

fn pem(label: &str, bytes: &[u8]) -> String {
    pem_rfc7468::encode_string(label, pem_rfc7468::LineEnding::LF, bytes).unwrap()
}

impl Pki {
    fn new() -> Self {
        let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages = vec![
            KeyUsagePurpose::KeyCertSign,
            KeyUsagePurpose::DigitalSignature,
            KeyUsagePurpose::CrlSign,
        ];
        let key = KeyPair::generate().unwrap();
        let ca = params.self_signed(&key).unwrap();
        Self {
            ca,
            issuer: Issuer::new(params, key),
        }
    }

    fn issue(&self, name: &str, server: bool, expired: bool) -> Identity {
        let mut params = CertificateParams::new(vec![name.into()]).unwrap();
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
        if server {
            params
                .extended_key_usages
                .push(ExtendedKeyUsagePurpose::ServerAuth);
        }
        if expired {
            params.not_after = rcgen::date_time_ymd(2000, 1, 1);
        }
        let key = KeyPair::generate().unwrap();
        let cert = params.signed_by(&key, &self.issuer).unwrap();
        Identity {
            cert_pem: pem("CERTIFICATE", cert.der().as_ref()),
            key_pem: pem("PRIVATE KEY", &key.serialize_der()),
            public_key_der: key.subject_public_key_info(),
            cert,
        }
    }
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let pki = Pki::new();
        std::fs::write(
            directory.path().join("ca.pem"),
            pem("CERTIFICATE", pki.ca.der().as_ref()),
        )
        .unwrap();
        let operator = pki.issue("operator.test", false, false);
        let unknown = pki.issue("unlisted.test", false, false);
        let mut nodes = BTreeMap::new();
        let mut peers = BTreeMap::new();
        let mut names = BTreeMap::new();
        let mut ports = BTreeSet::new();
        let bind_ip: std::net::IpAddr = std::env::var("VS_TEST_COORDINATION_IP")
            .unwrap_or_else(|_| "127.0.0.1".into())
            .parse()
            .expect("测试绑定IP无效");
        assert!(
            match bind_ip {
                std::net::IpAddr::V4(ip) => ip.is_loopback() || ip.is_private(),
                std::net::IpAddr::V6(ip) => ip.is_loopback() || ip.is_unique_local(),
            },
            "测试仅允许回环或明确私网地址"
        );
        println!("协调TLS测试绑定：{bind_ip}");
        for id in 1..=4 {
            let name = format!("node-{id}.coordination.test");
            let identity = pki.issue(&name, true, false);
            std::fs::write(
                directory.path().join(format!("node-{id}.pem")),
                &identity.cert_pem,
            )
            .unwrap();
            std::fs::write(
                directory.path().join(format!("node-{id}.key")),
                &identity.key_pem,
            )
            .unwrap();
            let address = loop {
                let address = std::net::TcpListener::bind(SocketAddr::new(bind_ip, 0))
                    .unwrap()
                    .local_addr()
                    .unwrap();
                if ports.insert(address.port()) {
                    break address;
                }
            };
            nodes.insert(id, identity);
            peers.insert(id, address);
            names.insert(id, name);
        }
        Self {
            directory,
            pki,
            nodes,
            operator,
            unknown,
            peers,
            names,
        }
    }

    fn tls(&self, id: NodeId) -> TlsSettings {
        TlsSettings {
            ca_file: self.directory.path().join("ca.pem"),
            certificate_file: self.directory.path().join(format!("node-{id}.pem")),
            private_key_file: self.directory.path().join(format!("node-{id}.key")),
            server_names: self.names.clone(),
            peer_sha256: self
                .nodes
                .iter()
                .map(|(id, identity)| (*id, fingerprint(identity.cert.der().as_ref())))
                .collect(),
            operator_sha256: vec![fingerprint(self.operator.cert.der().as_ref())],
            media_reader_sha256: BTreeMap::new(),
            profile_reader_sha256: BTreeMap::new(),
        }
    }

    fn settings(&self, id: NodeId, tls: bool) -> Value {
        let mut value = json!({
            "cluster_id":"mtls-test", "node_id":id, "bind":self.peers[&id],
            "data_dir":self.directory.path().join(format!("data-{id}")),
            "peers":self.peers, "voters":[1,2,3], "service_token":TOKEN
        });
        if tls {
            let material = self.tls(id);
            value["tls"] = json!({
                "ca_file":material.ca_file,"certificate_file":material.certificate_file,"private_key_file":material.private_key_file,
                "server_names":material.server_names,"peer_sha256":material.peer_sha256,"operator_sha256":material.operator_sha256
            });
        }
        value
    }

    fn start(&self, id: NodeId, tls: bool) -> Process {
        self.start_config(id, self.settings(id, tls))
    }

    fn start_config(&self, id: NodeId, settings: Value) -> Process {
        let config = self.directory.path().join(format!("config-{id}.json"));
        std::fs::write(&config, serde_json::to_vec(&settings).unwrap()).unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_vs-coordination"));
        command
            .env("VS_COORDINATION_CONFIG", config)
            .env("VS_COORDINATION_RUN_SECONDS", "300")
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        Process(command.spawn().unwrap())
    }

    fn client(&self, identity: &Identity) -> Client {
        TlsTransport::client_builder(
            &[self.pki.ca.der().clone()],
            format!("{}\n{}", identity.cert_pem, identity.key_pem).as_bytes(),
            &self.names,
            &self.peers,
        )
        .unwrap()
        .build()
        .unwrap()
    }

    fn url(&self, id: NodeId, path: &str) -> String {
        format!(
            "https://{}:{}{path}",
            self.names[&id],
            self.peers[&id].port()
        )
    }

    fn policy(&self) -> String {
        fingerprint(
            &serde_json::to_vec(&json!({"media_control":null, "transport":POLICY_MODE})).unwrap(),
        )
    }

    fn admin_settings(&self, identity: &Identity, nodes: &[NodeId]) -> Value {
        let certificate = self.directory.path().join("admin-client.pem");
        let key = self.directory.path().join("admin-client.key");
        std::fs::write(&certificate, &identity.cert_pem).unwrap();
        std::fs::write(&key, &identity.key_pem).unwrap();
        let names: BTreeMap<_, _> = nodes
            .iter()
            .map(|id| (self.peers[id], self.names[id].clone()))
            .collect();
        json!({
            "cluster_id":"mtls-test", "endpoints":nodes.iter().map(|id| self.peers[id]).collect::<Vec<_>>(),
            "service_token":TOKEN,
            "tls":{
                "ca_file":self.directory.path().join("ca.pem"),
                "certificate_file":certificate,"private_key_file":key,
                "certificate_sha256":fingerprint(identity.cert.der().as_ref()),"server_names":names
            }
        })
    }
}

fn media_register() -> Value {
    json!({
        "operation":"register_media","operation_id":"register","expected_revision":null,
        "registration":{"target":{"node_id":"media","incarnation":"abcdefghijklmnopqrstuv"},
            "endpoint":"127.0.0.1:35000","rooms":[{"tenant_id":"tenant","room_id":"one"}]}
    })
}

fn maintenance(operation: &str, revision: u64, draining: bool) -> MediaNodeCommand {
    serde_json::from_value(json!({
        "operation":"set_media_draining","operation_id":operation,"expected_revision":revision,
        "target":{"node_id":"media","incarnation":"abcdefghijklmnopqrstuv"},"draining":draining
    }))
    .unwrap()
}

async fn admin_cli(
    fixture: &Fixture,
    settings: &Value,
    mode: &str,
    argument: &str,
) -> std::process::Output {
    let config = fixture.directory.path().join("maintenance-client.json");
    std::fs::write(&config, serde_json::to_vec(settings).unwrap()).unwrap();
    let mode = mode.to_owned();
    let argument = argument.to_owned();
    tokio::task::spawn_blocking(move || {
        let mut command = Command::new(env!("CARGO_BIN_EXE_media-admin"));
        command.arg(config).arg(mode).arg(argument);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command.output().unwrap()
    })
    .await
    .unwrap()
}

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct TurnProcess {
    process: Process,
    ready: Value,
    stdout: std::thread::JoinHandle<std::io::Result<Vec<u8>>>,
    stderr: std::thread::JoinHandle<std::io::Result<Vec<u8>>>,
}

impl TurnProcess {
    async fn start(config: &Value, directory: &std::path::Path) -> Self {
        let binary = PathBuf::from(
            std::env::var_os("VS_TEST_TURN_BINARY").expect("必须指定TURN程序绝对路径"),
        );
        assert!(binary.is_absolute() && binary.is_file(), "TURN程序路径无效");
        let path = directory.join("turn-config.json");
        std::fs::write(&path, serde_json::to_vec(config).unwrap()).unwrap();
        let mut command = Command::new(binary);
        command
            .env("VS_TURN_CONFIG", &path)
            .env("VS_TURN_STOP_ON_STDIN_EOF", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut process = Process(command.spawn().unwrap());
        let output = process.0.stdout.take().unwrap();
        let error = process.0.stderr.take().unwrap();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        // 两路并发读取且各限8KiB；不用等子进程退出后才排空管道。
        let stdout = std::thread::spawn(move || {
            let mut reader = std::io::BufReader::new(output).take(8193);
            let mut bytes = Vec::new();
            let ready = reader.read_until(b'\n', &mut bytes).and_then(|_| {
                serde_json::from_slice::<Value>(&bytes).map_err(std::io::Error::other)
            });
            let _ = sender.send(ready);
            reader.read_to_end(&mut bytes)?;
            Ok(bytes)
        });
        let stderr = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            error.take(8193).read_to_end(&mut bytes)?;
            Ok(bytes)
        });
        let ready = tokio::time::timeout(Duration::from_secs(5), receiver)
            .await
            .expect("独立TURN程序未及时就绪")
            .unwrap()
            .expect("独立TURN就绪回执无效");
        assert_eq!(ready["schema"], "turn-lab-ready-v1");
        assert_eq!(ready["pid"], process.0.id());
        assert_eq!(ready["bind"], config["bind"]);
        assert_eq!(
            ready["expires_unix_seconds"],
            config["expires_unix_seconds"]
        );
        assert_eq!(ready["shutdown_on_stdin_eof"], true);
        assert!(process.0.try_wait().unwrap().is_none());
        Self {
            process,
            ready,
            stdout,
            stderr,
        }
    }

    async fn stop(mut self) -> Value {
        assert!(self.process.0.try_wait().unwrap().is_none(), "TURN提前退出");
        drop(self.process.0.stdin.take().expect("TURN父管道已经丢失"));
        let status = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(status) = self.process.0.try_wait().unwrap() {
                    break status;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("独立TURN程序未按父管道关闭退出");
        assert!(status.success(), "独立TURN退出码异常");
        let bytes = self.stdout.join().unwrap().unwrap();
        let errors = self.stderr.join().unwrap().unwrap();
        assert!(bytes.len() <= 8192 && errors.len() <= 8192, "TURN输出超限");
        assert!(errors.is_empty(), "独立TURN产生异常标准错误");
        let lines: Vec<Value> = bytes
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], self.ready);
        assert_eq!(lines[1]["schema"], "turn-lab-stopped-v1");
        assert_eq!(lines[1]["pid"], self.process.0.id());
        assert_eq!(lines[1]["bind"], self.ready["bind"]);
        assert_eq!(lines[1]["reason"], "stdin_eof");
        json!({
            "schema":"turn-process-receipt-v1","ready":self.ready,"stopped":lines[1],
            "exit_code":status.code(),"bounded_output_verified":true
        })
    }
}

async fn start_live(
    fixture: &Fixture,
    reader: &Identity,
    order: &[NodeId],
    drain: Option<Value>,
) -> (Process, SocketAddr, Value, Client) {
    start_live_signaling(fixture, reader, order, drain, None).await
}

async fn start_live_signaling(
    fixture: &Fixture,
    reader: &Identity,
    order: &[NodeId],
    drain: Option<Value>,
    signaling: Option<Value>,
) -> (Process, SocketAddr, Value, Client) {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use ring::signature::{Ed25519KeyPair, KeyPair};
    let binary =
        PathBuf::from(std::env::var_os("VS_TEST_LIVE_BINARY").expect("必须指定媒体程序绝对路径"));
    assert!(
        binary.is_absolute() && binary.is_file(),
        "媒体程序路径必须绝对且存在"
    );
    let settings = fixture.admin_settings(reader, order);
    let access_path = fixture.directory.path().join("live-access.json");
    let control_path = fixture.directory.path().join("live-room-control.json");
    let key = Ed25519KeyPair::from_seed_unchecked(&[27; 32]).unwrap();
    std::fs::write(&access_path, serde_json::to_vec(&json!({
        "issuer":"https://media-test.invalid","audience":"live","tenant_id":"tenant","room_id":"one","node_id":"media",
        "keys":[{"kid":"key","public_key":URL_SAFE_NO_PAD.encode(key.public_key().as_ref())}]
    })).unwrap()).unwrap();
    std::fs::write(&control_path, serde_json::to_vec(&json!({
        "cluster_id":"mtls-test","control_token":CONTROL_TOKEN,"coordination_token":TOKEN,
        "coordination_endpoints":order.iter().map(|id| format!("https://{}", fixture.peers[id])).collect::<Vec<_>>(),
        "coordination_tls":settings["tls"]
    })).unwrap()).unwrap();
    let address = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap();
    let mut command = Command::new(binary);
    command
        .env("VS_LIVE_BIND", address.to_string())
        .env("VS_LIVE_RUN_SECONDS", "30")
        .env("VS_LIVE_ACCESS_CONFIG", access_path)
        .env("VS_LIVE_ROOM_CONTROL_CONFIG", control_path)
        .env_remove("VS_LIVE_ROOMS_CONFIG")
        .env_remove("VS_LIVE_DRAIN_TLS_CONFIG")
        .env_remove("VS_LIVE_SIGNALING_TLS_CONFIG")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if let Some(config) = drain {
        let path = fixture.directory.path().join("drain-tls.json");
        std::fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
        command.env("VS_LIVE_DRAIN_TLS_CONFIG", path);
    }
    if let Some(mut config) = signaling {
        config["allowed_origins"] = json!([format!("http://{address}"), "https://app.example"]);
        let path = fixture.directory.path().join("signaling-tls.json");
        std::fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
        command.env("VS_LIVE_SIGNALING_TLS_CONFIG", path);
        if std::env::var_os("VS_TEST_SIGNALING_BROWSER_DIR").is_some() {
            command.env("VS_LIVE_RUN_SECONDS", "180");
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut process = Process(command.spawn().unwrap());
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    let binding = tokio::time::timeout(Duration::from_secs(12), async {
        loop {
            if process.0.try_wait().unwrap().is_some() {
                let mut message = String::new();
                process
                    .0
                    .stderr
                    .take()
                    .unwrap()
                    .read_to_string(&mut message)
                    .unwrap();
                panic!("媒体程序提前退出：{message}");
            }
            if let Ok(response) = client
                .get(format!("http://{address}/lab/node"))
                .send()
                .await
                && response.status() == StatusCode::OK
                && let Ok(value) = response.json::<Value>().await
            {
                break value["binding"].clone();
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("媒体程序就绪超时");
    (process, address, binding, client)
}

fn release_settings(fixture: &Fixture, node: NodeId, endpoint: SocketAddr) -> Value {
    json!({
        "endpoints":{"media":endpoint},"control_token":CONTROL_TOKEN,
        "tls":{
            "ca_file":fixture.directory.path().join("ca.pem"),
            "certificate_file":fixture.tls(node).certificate_file,
            "private_key_file":fixture.tls(node).private_key_file,
            "certificate_sha256":fingerprint(fixture.nodes[&node].cert.der().as_ref()),
            "server_names":BTreeMap::from([(endpoint,"media.control.test")])
        }
    })
}

fn server_settings(fixture: &Fixture, identity: &Identity) -> Value {
    let certificate = fixture.directory.path().join("media-server.pem");
    let key = fixture.directory.path().join("media-server.key");
    std::fs::write(&certificate, &identity.cert_pem).unwrap();
    std::fs::write(&key, &identity.key_pem).unwrap();
    json!({"ca_file":fixture.directory.path().join("ca.pem"),"certificate_file":certificate,
        "private_key_file":key,"certificate_sha256":fingerprint(identity.cert.der().as_ref()),"server_name":"media.control.test"})
}

fn control_client(fixture: &Fixture, identity: &Identity, endpoint: SocketAddr) -> Client {
    TlsTransport::client_builder(
        &[fixture.pki.ca.der().clone()],
        format!("{}\n{}", identity.cert_pem, identity.key_pem).as_bytes(),
        &BTreeMap::from([(1, "media.control.test".into())]),
        &BTreeMap::from([(1, endpoint)]),
    )
    .unwrap()
    .timeout(Duration::from_secs(3))
    .build()
    .unwrap()
}

#[test]
fn fixed_mtls_server_checks_server_usage_name_fingerprint_and_private_key_before_listen() {
    let fixture = Fixture::new();
    let mut params = CertificateParams::new(vec!["media.control.test".into()]).unwrap();
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let key = KeyPair::generate().unwrap();
    let cert = params.signed_by(&key, &fixture.pki.issuer).unwrap();
    let identity = Identity {
        cert_pem: pem("CERTIFICATE", cert.der().as_ref()),
        key_pem: pem("PRIVATE KEY", &key.serialize_der()),
        public_key_der: key.subject_public_key_info(),
        cert,
    };
    let good = server_settings(&fixture, &identity);
    assert!(
        serde_json::from_value::<vs_tls::FixedServerTls>(good.clone())
            .unwrap()
            .load()
            .is_ok()
    );
    for case in [
        "name",
        "fingerprint",
        "private-key",
        "client-only",
        "relative-key",
    ] {
        let mut value = good.clone();
        match case {
            "name" => value["server_name"] = json!("wrong.control.test"),
            "fingerprint" => value["certificate_sha256"] = json!("0".repeat(64)),
            "private-key" => value["private_key_file"] = json!(fixture.tls(2).private_key_file),
            "client-only" => {
                value = server_settings(
                    &fixture,
                    &fixture.pki.issue("media.control.test", false, false),
                )
            }
            "relative-key" => value["private_key_file"] = json!("relative.key"),
            _ => unreachable!(),
        }
        assert!(
            serde_json::from_value::<vs_tls::FixedServerTls>(value)
                .unwrap()
                .load()
                .is_err(),
            "服务材料应拒绝：{case}"
        );
        let _ = server_settings(&fixture, &identity);
    }
}

async fn ready(fixture: &Fixture, client: &Client, id: NodeId, process: &mut Process) {
    tokio::time::timeout(Duration::from_secs(12), async {
        loop {
            if process.0.try_wait().unwrap().is_some() {
                let mut error = String::new();
                process
                    .0
                    .stderr
                    .take()
                    .unwrap()
                    .read_to_string(&mut error)
                    .unwrap();
                panic!("协调进程提前退出：{error}");
            }
            if client
                .get(fixture.url(id, "/metrics"))
                .bearer_auth(TOKEN)
                .send()
                .await
                .is_ok_and(|response| response.status() == StatusCode::OK)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("TLS协调进程就绪超时");
}

async fn leader(fixture: &Fixture, client: &Client, live: &[NodeId]) -> NodeId {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            for &id in live {
                if let Ok(response) = client
                    .get(fixture.url(id, "/metrics"))
                    .bearer_auth(TOKEN)
                    .send()
                    .await
                    && let Ok(value) = response.json::<Value>().await
                    && value["state"] == "Leader"
                {
                    return id;
                }
            }
            tokio::time::sleep(Duration::from_millis(75)).await;
        }
    })
    .await
    .expect("TLS协调集群未在预算内产生主节点")
}

async fn post(
    fixture: &Fixture,
    client: &Client,
    id: NodeId,
    path: &str,
    value: &Value,
) -> reqwest::Response {
    client
        .post(fixture.url(id, path))
        .bearer_auth(TOKEN)
        .json(value)
        .send()
        .await
        .unwrap()
}

fn command(operation: &str, room: &str) -> Value {
    json!({"operation":"assign","tenant_id":"tenant","room_id":room,"operation_id":operation,"expected_revision":null,
        "target":{"node_id":"media","incarnation":"abcdefghijklmnopqrstuv"}})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn profile_lab_mode_preserves_tls_roles_fixed_policy_and_durable_epoch_fence() {
    let fixture = Fixture::new();
    let operator = fixture.client(&fixture.operator);
    let node_client = fixture.client(&fixture.nodes[&1]);
    let media_identity = fixture
        .pki
        .issue("profile-forbidden-reader.test", false, false);
    let media_client = fixture.client(&media_identity);
    let catalog = fixture.directory.path().join("profile-catalog.json");
    let bytes = br#"{"version":"profile-tls-v1","assets":[],"items":[
        {"id":"document","domain":"document","tags":["rust"],"prior":0.5,"media_sha256":null}
    ]}"#;
    std::fs::write(&catalog, bytes).unwrap();
    let mut settings = fixture.settings(1, true);
    settings["voters"] = json!([1]);
    settings["profile_catalog"] = json!(catalog);
    settings["profile_shard_count"] = json!(2);
    settings["tls"]["media_reader_sha256"] = json!({
        "reader":fingerprint(media_identity.cert.der().as_ref())
    });
    let mut process = fixture.start_config(1, settings.clone());
    ready(&fixture, &operator, 1, &mut process).await;
    assert_eq!(
        post(&fixture, &operator, 1, "/admin/initialize", &json!({}))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    leader(&fixture, &operator, &[1]).await;
    let target = json!({"node_id":"writer-a","incarnation":"aaaaaaaaaaaaaaaaaaaaaa"});
    let claim = json!({"operation":"set_profile_writer","change":{
        "operation_id":"initial","shard":0,"expected_revision":null,"target":target
    }});
    for client in [&node_client, &media_client] {
        assert_eq!(
            post(
                &fixture,
                client,
                1,
                "/internal/lab/profile/commands",
                &claim
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            client
                .get(fixture.url(1, "/internal/lab/profile/writers/0"))
                .bearer_auth(TOKEN)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    let response = post(
        &fixture,
        &operator,
        1,
        "/internal/lab/profile/commands",
        &claim,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let claimed: Value = response.json().await.unwrap();
    let epoch = claimed["writer"]["revision"].as_u64().unwrap();
    let policy = vs_coordination::profile_authority::ProfilePolicy::from_catalog(bytes, 2).unwrap();
    let subject = (0..100)
        .map(|id| format!("tls-user-{id}"))
        .find(|subject| policy.shard_for(subject) == 0)
        .unwrap();
    let event = json!({"operation":"commit_profile_event","shard":0,"writer_epoch":epoch,
        "target":target,"event":{"event_id":"hide","subject":subject,
        "candidate_id":"document","kind":"hide"}});
    assert_eq!(
        post(
            &fixture,
            &operator,
            1,
            "/internal/lab/profile/commands",
            &event
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        post(
            &fixture,
            &operator,
            1,
            "/v1/rooms/commands",
            &command("denied", "one")
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let rotate = json!({"operation":"set_profile_writer","change":{
        "operation_id":"rotate","shard":0,"expected_revision":epoch,
        "target":{"node_id":"writer-b","incarnation":"bbbbbbbbbbbbbbbbbbbbbb"}
    }});
    assert_eq!(
        post(
            &fixture,
            &operator,
            1,
            "/internal/lab/profile/commands",
            &rotate
        )
        .await
        .status(),
        StatusCode::OK
    );
    drop(process);
    let mut process = fixture.start_config(1, settings.clone());
    ready(&fixture, &operator, 1, &mut process).await;
    leader(&fixture, &operator, &[1]).await;
    let response = post(
        &fixture,
        &operator,
        1,
        "/internal/lab/profile/commands",
        &event,
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(response.json::<Value>().await.unwrap()["outcome"], "fenced");
    let response = post(
        &fixture,
        &operator,
        1,
        "/internal/lab/profile/projection",
        &json!({"subject":subject,"domains":["document"]}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.json::<Value>().await.unwrap()["profile"]["blocked_ids"],
        json!(["document"])
    );
    drop(process);
    settings["profile_shard_count"] = json!(4);
    let mut changed = fixture.start_config(1, settings.clone());
    assert!(!exited(&mut changed).await.0.success());
    settings.as_object_mut().unwrap().remove("profile_catalog");
    settings
        .as_object_mut()
        .unwrap()
        .remove("profile_shard_count");
    let mut downgraded = fixture.start_config(1, settings);
    assert!(!exited(&mut downgraded).await.0.success());
}

#[tokio::test]
async fn profile_reader_configuration_requires_tls_profile_mode_and_distinct_paired_token() {
    let fixture = Fixture::new();
    let catalog = fixture.directory.path().join("reader-catalog.json");
    std::fs::write(
        &catalog,
        br#"{"version":"reader-config","assets":[],"items":[
        {"id":"document","domain":"document","tags":["rust"],"prior":0.5,"media_sha256":null}]}"#,
    )
    .unwrap();
    for case in [
        "missing-token",
        "missing-role",
        "missing-access",
        "same-token",
        "short-token",
        "plain",
        "room",
    ] {
        let mut settings = fixture.settings(1, true);
        let data = fixture.directory.path().join(format!("rejected-{case}"));
        settings["data_dir"] = json!(data);
        settings["profile_catalog"] = json!(catalog);
        settings["profile_shard_count"] = json!(2);
        settings["profile_read_token"] = json!(CONTROL_TOKEN);
        settings["profile_access"] = profile_access_settings(32);
        settings["tls"]["profile_reader_sha256"] =
            json!({"feed":fingerprint(fixture.unknown.cert.der().as_ref())});
        match case {
            "missing-token" => {
                settings
                    .as_object_mut()
                    .unwrap()
                    .remove("profile_read_token");
            }
            "missing-role" => {
                settings["tls"]["profile_reader_sha256"] = json!({});
            }
            "missing-access" => {
                settings.as_object_mut().unwrap().remove("profile_access");
            }
            "same-token" => settings["profile_read_token"] = json!(TOKEN),
            "short-token" => settings["profile_read_token"] = json!("short"),
            "plain" => {
                settings.as_object_mut().unwrap().remove("tls");
            }
            "room" => {
                settings.as_object_mut().unwrap().remove("profile_catalog");
                settings
                    .as_object_mut()
                    .unwrap()
                    .remove("profile_shard_count");
            }
            _ => unreachable!(),
        }
        let mut process = fixture.start_config(1, settings);
        assert!(!exited(&mut process).await.0.success(), "应拒绝：{case}");
        assert!(!data.exists(), "拒绝前不得创建数据库：{case}");
    }
}

async fn profile_tls_feed(
    client: &Client,
    port: u16,
    signed: &str,
    profile_access: Option<&str>,
) -> reqwest::Response {
    let request = client
        .post(format!("http://127.0.0.1:{port}/internal/v2/feed"))
        .bearer_auth(CONTROL_TOKEN)
        .header("x-feed-identity", format!("Bearer {signed}"))
        .json(&json!({"request_id":"tls-feed","domains":["video","document","service"],"limit":3}));
    let request = match profile_access {
        Some(token) => request.header("x-profile-access-grant", format!("Bearer {token}")),
        None => request,
    };
    request.send().await.unwrap()
}

async fn read_profile_projection(
    client: &Client,
    url: &str,
    read_token: &str,
    grant: Option<&str>,
    subject: &str,
    domains: &[&str],
) -> reqwest::Response {
    let request = client
        .post(url)
        .bearer_auth(read_token)
        .json(&json!({"subject":subject,"domains":domains}));
    let request = match grant {
        Some(grant) => request.header("x-profile-access-grant", format!("Bearer {grant}")),
        None => request,
    };
    request.send().await.unwrap()
}

fn profile_access_settings(seed: u8) -> Value {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use ring::signature::{Ed25519KeyPair, KeyPair};

    let key = Ed25519KeyPair::from_seed_unchecked(&[seed; 32]).unwrap();
    json!({
        "issuer":PROFILE_ISSUER,
        "audience":PROFILE_AUDIENCE,
        "keys":[{"kid":"profile","public_key":URL_SAFE_NO_PAD.encode(key.public_key().as_ref())}]
    })
}

fn profile_access_token(subject: &str, domains: &[&str], signing_seed: u8) -> String {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use ring::signature::Ed25519KeyPair;

    let signer = Ed25519KeyPair::from_seed_unchecked(&[signing_seed; 32]).unwrap();
    let header = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&json!({"alg":"EdDSA","typ":"vs-profile-read+jwt","kid":"profile"}))
            .unwrap(),
    );
    let issued = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .saturating_sub(1);
    let claims = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&json!({
            "iss":PROFILE_ISSUER,
            "aud":PROFILE_AUDIENCE,
            "sub":subject,
            "iat":issued,
            "nbf":issued,
            "exp":issued+120,
            "domains":domains
        }))
        .unwrap(),
    );
    let message = format!("{header}.{claims}");
    format!(
        "{message}.{}",
        URL_SAFE_NO_PAD.encode(signer.sign(message.as_bytes()).as_ref())
    )
}

fn profile_api_process(
    binary: &std::path::Path,
    catalog: &std::path::Path,
    config: &std::path::Path,
    access: &std::path::Path,
    port: u16,
) -> Process {
    let mut command = Command::new(binary);
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with("VS_") {
            command.env_remove(name);
        }
    }
    command
        .env("VS_ROLE", "api")
        .env("VS_BIND", format!("127.0.0.1:{port}"))
        .env("VS_CATALOG", catalog)
        .env("VS_SERVICE_TOKEN", CONTROL_TOKEN)
        .env("VS_PROFILE_CONSENSUS_CONFIG", config)
        .env("VS_FEED_ACCESS_CONFIG", access)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    Process(command.spawn().unwrap())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "需VS_TEST_SERVICE_BINARY指向已构建API；跨包双向TLS读取角色实际进程"]
async fn profile_reader_mtls_feeds_signed_apis_and_cannot_use_control_permissions() {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use ring::signature::{Ed25519KeyPair, KeyPair};

    let binary =
        PathBuf::from(std::env::var_os("VS_TEST_SERVICE_BINARY").expect("缺少API程序绝对路径"));
    assert!(binary.is_absolute() && binary.is_file());
    let fixture = Fixture::new();
    let reader = fixture.pki.issue("feed-reader.test", false, false);
    let operator = fixture.client(&fixture.operator);
    let read_client = fixture.client(&reader);
    let catalog = fixture.directory.path().join("feed-catalog.json");
    let bytes = br#"{"version":"profile-reader-tls","assets":[],"items":[
        {"id":"video","domain":"video","tags":["rust"],"prior":0.7,"media_sha256":null},
        {"id":"document","domain":"document","tags":["rust"],"prior":0.4,"media_sha256":null},
        {"id":"service","domain":"service","tags":["storage"],"prior":0.6,"media_sha256":null}]}"#;
    std::fs::write(&catalog, bytes).unwrap();
    let mut nodes = BTreeMap::new();
    for id in 1..=3 {
        let mut settings = fixture.settings(id, true);
        settings["profile_catalog"] = json!(catalog);
        settings["profile_shard_count"] = json!(2);
        settings["profile_read_token"] = json!(CONTROL_TOKEN);
        settings["profile_access"] = profile_access_settings(32);
        settings["tls"]["profile_reader_sha256"] =
            json!({"feed":fingerprint(reader.cert.der().as_ref())});
        let mut node = fixture.start_config(id, settings);
        ready(&fixture, &operator, id, &mut node).await;
        nodes.insert(id, node);
    }
    assert_eq!(
        post(&fixture, &operator, 1, "/admin/initialize", &json!({}))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    let first = leader(&fixture, &operator, &[1, 2, 3]).await;
    let target = json!({"node_id":"writer","incarnation":"aaaaaaaaaaaaaaaaaaaaaa"});
    let claim = json!({"operation":"set_profile_writer","change":{
        "operation_id":"initial","shard":0,"expected_revision":null,"target":target}});
    let response = post(
        &fixture,
        &operator,
        first,
        "/internal/lab/profile/commands",
        &claim,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let epoch = response.json::<Value>().await.unwrap()["writer"]["revision"]
        .as_u64()
        .unwrap();
    let policy = vs_coordination::profile_authority::ProfilePolicy::from_catalog(bytes, 2).unwrap();
    let subject = (0..100)
        .map(|id| format!("tls-feed-user-{id}"))
        .find(|subject| policy.shard_for(subject) == 0)
        .unwrap();
    let hidden = json!({"operation":"commit_profile_event","shard":0,"writer_epoch":epoch,
        "target":target,"event":{"event_id":"hide","subject":subject,"candidate_id":"document","kind":"hide"}});
    assert_eq!(
        post(
            &fixture,
            &operator,
            first,
            "/internal/lab/profile/commands",
            &hidden
        )
        .await
        .status(),
        StatusCode::OK
    );
    let writer_view: Value = operator
        .get(fixture.url(first, "/internal/lab/profile/writers/0"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let minimum = writer_view["applied_index"].as_u64().unwrap();
    // 即使泄漏控制令牌，读取证书仍不能跨过方法与路径角色边界。
    for token in [CONTROL_TOKEN, TOKEN] {
        for (method, path) in [
            (reqwest::Method::POST, "/internal/lab/profile/commands"),
            (reqwest::Method::GET, "/internal/lab/profile/writers/0"),
            (reqwest::Method::POST, "/admin/initialize"),
            (reqwest::Method::POST, "/admin/snapshot"),
            (reqwest::Method::POST, "/admin/membership"),
            (reqwest::Method::GET, "/metrics"),
            (reqwest::Method::POST, "/raft/vote"),
            (reqwest::Method::POST, "/v1/rooms/commands"),
            (reqwest::Method::GET, "/v1/room-assignments/tenant/room"),
            (reqwest::Method::GET, "/internal/lab/profile/projection"),
            (reqwest::Method::POST, "/internal/lab/profile/ready"),
        ] {
            let response = read_client
                .request(method, fixture.url(first, path))
                .bearer_auth(token)
                .json(&claim)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "不应允许：{path}");
        }
    }
    for (client, token, expected) in [
        (&read_client, TOKEN, StatusCode::UNAUTHORIZED),
        (&operator, CONTROL_TOKEN, StatusCode::UNAUTHORIZED),
        (
            &fixture.client(&fixture.unknown),
            CONTROL_TOKEN,
            StatusCode::FORBIDDEN,
        ),
        (
            &fixture.client(&fixture.nodes[&1]),
            CONTROL_TOKEN,
            StatusCode::FORBIDDEN,
        ),
    ] {
        assert_eq!(
            client
                .get(fixture.url(first, "/internal/lab/profile/ready"))
                .bearer_auth(token)
                .send()
                .await
                .unwrap()
                .status(),
            expected
        );
    }
    let cert = fixture.directory.path().join("feed-reader.pem");
    let key = fixture.directory.path().join("feed-reader.key");
    std::fs::write(&cert, &reader.cert_pem).unwrap();
    std::fs::write(&key, &reader.key_pem).unwrap();
    let tls = json!({"ca_file":fixture.directory.path().join("ca.pem"),"certificate_file":cert,
        "private_key_file":key,"certificate_sha256":fingerprint(reader.cert.der().as_ref()),
        "server_names":(1..=3).map(|id|(fixture.peers[&id],fixture.names[&id].clone())).collect::<BTreeMap<_,_>>()});
    let config = fixture.directory.path().join("feed-reader.json");
    let read_config = json!({
        "cluster_id":"mtls-test","endpoints":(1..=3).map(|id|fixture.peers[&id]).collect::<Vec<_>>(),
        "service_token":CONTROL_TOKEN,"shard_count":2,"minimum_applied_index":minimum,
        "profile_access_audience":PROFILE_AUDIENCE,
        "tls":tls
    });
    std::fs::write(&config, serde_json::to_vec(&read_config).unwrap()).unwrap();
    let signer = Ed25519KeyPair::from_seed_unchecked(&[31; 32]).unwrap();
    let access = fixture.directory.path().join("feed-access.json");
    std::fs::write(
        &access,
        serde_json::to_vec(&json!({
        "issuer":"https://synthetic-feed.example","audience":"feed-api","keys":[{
            "kid":"synthetic","public_key":URL_SAFE_NO_PAD.encode(signer.public_key().as_ref())}]}))
        .unwrap(),
    )
    .unwrap();
    let foreign_ca = fixture.directory.path().join("foreign-ca.pem");
    std::fs::write(
        &foreign_ca,
        pem("CERTIFICATE", Pki::new().ca.der().as_ref()),
    )
    .unwrap();
    let expired = fixture.pki.issue("expired-feed.test", false, true);
    let expired_cert = fixture.directory.path().join("expired-feed.pem");
    let expired_key = fixture.directory.path().join("expired-feed.key");
    std::fs::write(&expired_cert, expired.cert_pem).unwrap();
    std::fs::write(&expired_key, expired.key_pem).unwrap();
    for case in [
        "fingerprint",
        "key",
        "expired",
        "ca",
        "names",
        "downgrade",
        "unknown",
    ] {
        let mut invalid = read_config.clone();
        match case {
            "fingerprint" => invalid["tls"]["certificate_sha256"] = json!("0".repeat(64)),
            "key" => invalid["tls"]["private_key_file"] = json!(fixture.tls(1).private_key_file),
            "expired" => {
                invalid["tls"]["certificate_file"] = json!(expired_cert);
                invalid["tls"]["private_key_file"] = json!(expired_key);
                invalid["tls"]["certificate_sha256"] =
                    json!(fingerprint(expired.cert.der().as_ref()));
            }
            "ca" => invalid["tls"]["ca_file"] = json!(foreign_ca),
            "names" => {
                for (index, name) in invalid["tls"]["server_names"]
                    .as_object_mut()
                    .unwrap()
                    .values_mut()
                    .enumerate()
                {
                    *name = json!(format!("wrong-{index}.feed.test"));
                }
            }
            "downgrade" => invalid["tls"] = Value::Null,
            "unknown" => invalid["tls"]["accept_invalid_certs"] = json!(true),
            _ => unreachable!(),
        }
        let path = fixture
            .directory
            .path()
            .join(format!("invalid-{case}.json"));
        std::fs::write(&path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        let mut process = profile_api_process(&binary, &catalog, &path, &access, 0);
        let (status, diagnostic) = exited(&mut process).await;
        assert!(!status.success(), "TLS配置必须拒绝：{case}");
        assert!(!diagnostic.contains(CONTROL_TOKEN) && !diagnostic.contains(TOKEN));
    }
    let header = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&json!({"alg":"EdDSA","typ":"vs-feed+jwt","kid":"synthetic"})).unwrap(),
    );
    let issued = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        - 1;
    let claims = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&json!({
        "iss":"https://synthetic-feed.example","aud":"feed-api","sub":subject,
        "iat":issued,"nbf":issued,"exp":issued+120,"domains":["video","document","service"]}))
        .unwrap(),
    );
    let message = format!("{header}.{claims}");
    let signed = format!(
        "{message}.{}",
        URL_SAFE_NO_PAD.encode(signer.sign(message.as_bytes()).as_ref())
    );
    let profile_grant = profile_access_token(&subject, &["video", "document", "service"], 32);
    let wrong_subject_grant =
        profile_access_token("other-subject", &["video", "document", "service"], 32);
    let wrong_key_grant = profile_access_token(&subject, &["video", "document", "service"], 33);
    let profile_url = fixture.url(first, "/internal/lab/profile/projection");
    assert_eq!(
        read_profile_projection(
            &read_client,
            &profile_url,
            CONTROL_TOKEN,
            None,
            &subject,
            &["document"],
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        read_profile_projection(
            &read_client,
            &profile_url,
            CONTROL_TOKEN,
            Some(&wrong_subject_grant),
            &subject,
            &["document"],
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    let narrow_grant = profile_access_token(&subject, &["video"], 32);
    assert_eq!(
        read_profile_projection(
            &read_client,
            &profile_url,
            CONTROL_TOKEN,
            Some(&narrow_grant),
            &subject,
            &["document"],
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        read_profile_projection(
            &read_client,
            &profile_url,
            CONTROL_TOKEN,
            Some(&wrong_key_grant),
            &subject,
            &["document"],
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    let valid_direct = read_profile_projection(
        &read_client,
        &profile_url,
        CONTROL_TOKEN,
        Some(&profile_grant),
        &subject,
        &["document"],
    )
    .await
    .error_for_status()
    .unwrap()
    .json::<Value>()
    .await
    .unwrap();
    assert_eq!(valid_direct["profile"]["blocked_ids"], json!(["document"]));
    let client = Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(4))
        .build()
        .unwrap();
    let mut apis = Vec::new();
    let mut ports = Vec::new();
    for _ in 0..2 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let mut node = profile_api_process(&binary, &catalog, &config, &access, port);
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                assert!(node.0.try_wait().unwrap().is_none(), "TLS画像API提前退出");
                if client
                    .get(format!("http://127.0.0.1:{port}/readyz"))
                    .bearer_auth(CONTROL_TOKEN)
                    .send()
                    .await
                    .is_ok_and(|response| response.status() == StatusCode::OK)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap();
        apis.push(node);
        ports.push(port);
    }
    let check = async |port| {
        let response = profile_tls_feed(&client, port, &signed, Some(&profile_grant)).await;
        assert_eq!(response.status(), StatusCode::OK);
        let value: Value = response.json().await.unwrap();
        assert_eq!(value["profile_version"], "memory-1");
        let items = value["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|item| item["id"] != "document"));
    };
    assert_eq!(
        profile_tls_feed(&client, ports[0], &signed, None)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        profile_tls_feed(&client, ports[0], &signed, Some(&wrong_subject_grant),)
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        profile_tls_feed(&client, ports[0], &signed, Some(&wrong_key_grant))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    for &port in &ports {
        check(port).await;
    }
    drop(nodes.remove(&first));
    let live: Vec<_> = nodes.keys().copied().collect();
    let second = leader(&fixture, &operator, &live).await;
    for &port in &ports {
        check(port).await;
    }
    let other = *nodes.keys().find(|&&id| id != second).unwrap();
    drop(nodes.remove(&other));
    for &port in &ports {
        assert_eq!(
            profile_tls_feed(&client, port, &signed, Some(&profile_grant))
                .await
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
    drop(apis);
    drop(nodes);
    for port in ports {
        drop(std::net::TcpListener::bind(("127.0.0.1", port)).unwrap());
    }
    for id in 1..=3 {
        drop(std::net::TcpListener::bind(fixture.peers[&id]).unwrap());
    }
    println!(
        "{}",
        json!({"schema":"profile-reader-mtls-process-v1",
        "coordinators":3,"api_processes":2,"physical_hosts":1,"tls_version":"1.3",
        "initial_leader":first,"replacement_leader":second,"minimum_applied_index":minimum,
        "signed_cross_domain_hide":true,"readonly_role_with_control_token_denied":true,
        "scoped_profile_grant_enforced":true,"missing_profile_grant_rejected":true,
        "wrong_subject_grant_rejected":true,"narrow_domain_grant_rejected":true,
        "untrusted_profile_signer_rejected":true,
        "wrong_role_token_pair_rejected":true,"minimal_readiness":true,
        "tls_client_configuration_rejections":7,
        "coordination_bind":fixture.peers[&first].ip(),
        "failover":true,"minority_feed_unavailable":true,"process_and_tcp_reclaimed":true,
        "synthetic_identity_only":true,"production_admitted":false})
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn profile_reader_rotation_rejects_retired_certificate_and_token_without_losing_hide() {
    let fixture = Fixture::new();
    let operator = fixture.client(&fixture.operator);
    let old = fixture.pki.issue("old-feed.test", false, false);
    let replacement = fixture.pki.issue("new-feed.test", false, false);
    let old_client = fixture.client(&old);
    let new_client = fixture.client(&replacement);
    let next_token = "rotated-profile-read-only-token-0000000000";
    let catalog = fixture.directory.path().join("rotation-catalog.json");
    let bytes = br#"{"version":"profile-rotation","assets":[],"items":[
        {"id":"document","domain":"document","tags":["rust"],"prior":0.5,"media_sha256":null}]}"#;
    std::fs::write(&catalog, bytes).unwrap();
    let mut settings = fixture.settings(1, true);
    settings["voters"] = json!([1]);
    settings["profile_catalog"] = json!(catalog);
    settings["profile_shard_count"] = json!(2);
    settings["profile_read_token"] = json!(CONTROL_TOKEN);
    settings["profile_access"] = profile_access_settings(32);
    settings["tls"]["profile_reader_sha256"] = json!({"feed":fingerprint(old.cert.der().as_ref())});
    let mut process = fixture.start_config(1, settings.clone());
    ready(&fixture, &operator, 1, &mut process).await;
    assert_eq!(
        post(&fixture, &operator, 1, "/admin/initialize", &json!({}))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    leader(&fixture, &operator, &[1]).await;
    let target = json!({"node_id":"writer","incarnation":"aaaaaaaaaaaaaaaaaaaaaa"});
    let claim = json!({"operation":"set_profile_writer","change":{
        "operation_id":"claim","shard":0,"expected_revision":null,"target":target}});
    let epoch = post(
        &fixture,
        &operator,
        1,
        "/internal/lab/profile/commands",
        &claim,
    )
    .await
    .error_for_status()
    .unwrap()
    .json::<Value>()
    .await
    .unwrap()["writer"]["revision"]
        .as_u64()
        .unwrap();
    let policy = vs_coordination::profile_authority::ProfilePolicy::from_catalog(bytes, 2).unwrap();
    let subject = (0..100)
        .map(|id| format!("rotation-user-{id}"))
        .find(|subject| policy.shard_for(subject) == 0)
        .unwrap();
    let grant = profile_access_token(&subject, &["document"], 32);
    let hidden = json!({"operation":"commit_profile_event","shard":0,"writer_epoch":epoch,
        "target":target,"event":{"event_id":"hide","subject":subject,"candidate_id":"document","kind":"hide"}});
    assert_eq!(
        post(
            &fixture,
            &operator,
            1,
            "/internal/lab/profile/commands",
            &hidden
        )
        .await
        .status(),
        StatusCode::OK
    );
    let read = async |client: &Client, token: &str| {
        read_profile_projection(
            client,
            &fixture.url(1, "/internal/lab/profile/projection"),
            token,
            Some(&grant),
            &subject,
            &["document"],
        )
        .await
    };
    assert_eq!(
        read(&old_client, CONTROL_TOKEN).await.status(),
        StatusCode::OK
    );
    drop(process);
    settings["tls"]["profile_reader_sha256"] =
        json!({"feed":fingerprint(replacement.cert.der().as_ref())});
    settings["profile_read_token"] = json!(next_token);
    let mut process = fixture.start_config(1, settings);
    ready(&fixture, &operator, 1, &mut process).await;
    leader(&fixture, &operator, &[1]).await;
    for token in [CONTROL_TOKEN, next_token, TOKEN] {
        assert_eq!(
            read(&old_client, token).await.status(),
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        read(&new_client, CONTROL_TOKEN).await.status(),
        StatusCode::UNAUTHORIZED
    );
    let response = read(&new_client, next_token)
        .await
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(response["profile"]["blocked_ids"], json!(["document"]));
    drop(process);
}

async fn exited(process: &mut Process) -> (std::process::ExitStatus, String) {
    let status = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if let Some(status) = process.0.try_wait().unwrap() {
                break status;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("预期拒绝的配置未退出");
    let mut diagnostic = String::new();
    process
        .0
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut diagnostic)
        .unwrap();
    (status, diagnostic)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mtls_cluster_commits_adds_learner_changes_membership_survives_leader_loss_and_restarts() {
    let fixture = Fixture::new();
    let client = fixture.client(&fixture.operator);
    let mut processes = BTreeMap::new();
    for id in 1..=3 {
        let mut process = fixture.start(id, true);
        ready(&fixture, &client, id, &mut process).await;
        processes.insert(id, process);
    }
    assert_eq!(
        post(&fixture, &client, 1, "/admin/initialize", &json!({}))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    let primary = leader(&fixture, &client, &[1, 2, 3]).await;
    let accepted = post(
        &fixture,
        &client,
        primary,
        "/v1/rooms/commands",
        &command("first", "one"),
    )
    .await;
    assert_eq!(accepted.status(), StatusCode::OK);
    let first: Value = accepted.json().await.unwrap();
    assert_eq!(first["outcome"], "applied");

    let mut fourth = fixture.start(4, true);
    ready(&fixture, &client, 4, &mut fourth).await;
    processes.insert(4, fourth);
    assert_eq!(
        post(&fixture, &client, primary, "/admin/learners/4", &json!({}))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        post(
            &fixture,
            &client,
            primary,
            "/admin/membership",
            &json!({"nodes":[1,2,3,4]})
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    drop(processes.remove(&primary));
    let live: Vec<_> = processes.keys().copied().collect();
    let replacement = leader(&fixture, &client, &live).await;
    let response = client
        .get(fixture.url(replacement, "/v1/rooms/tenant/one"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(response, first["record"]);
    let accepted = post(
        &fixture,
        &client,
        replacement,
        "/v1/rooms/commands",
        &command("second", "two"),
    )
    .await;
    assert_eq!(accepted.status(), StatusCode::OK);
    let second: Value = accepted.json().await.unwrap();
    let committed_index = second["record"]["revision"].as_u64().unwrap();
    let mut restored = fixture.start(primary, true);
    ready(&fixture, &client, primary, &mut restored).await;
    processes.insert(primary, restored);
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            // 跟随者不提供线性一致业务读；用其应用水位证明追平，再从主节点核对业务状态。
            let response = client
                .get(fixture.url(primary, "/metrics"))
                .bearer_auth(TOKEN)
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .json::<Value>()
                .await
                .unwrap();
            if response["last_applied"]["index"]
                .as_u64()
                .is_some_and(|index| index >= committed_index)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    let restored: Value = client
        .get(fixture.url(replacement, "/v1/rooms/tenant/two"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(restored, second["record"]);
    let replay: Value = post(
        &fixture,
        &client,
        replacement,
        "/v1/rooms/commands",
        &command("first", "one"),
    )
    .await
    .json()
    .await
    .unwrap();
    assert_eq!(replay["outcome"], "duplicate");
    assert_eq!(replay["record"]["revision"], first["record"]["revision"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mtls_certificate_names_roles_rpc_sender_plaintext_and_policy_downgrade_fail_closed() {
    let fixture = Fixture::new();
    let operator = fixture.client(&fixture.operator);
    let mut first = fixture.start(1, true);
    let mut second = fixture.start(2, true);
    ready(&fixture, &operator, 1, &mut first).await;
    ready(&fixture, &operator, 2, &mut second).await;
    let node = fixture.client(&fixture.nodes[&1]);
    assert_eq!(
        post(&fixture, &node, 1, "/admin/initialize", &json!({}))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let vote = serde_json::to_value(openraft::raft::VoteRequest {
        vote: openraft::Vote::new(10, 2_u64),
        last_log_id: None,
    })
    .unwrap();
    let response = node
        .post(fixture.url(2, "/raft/vote"))
        .bearer_auth(TOKEN)
        .header("x-vs-room-policy", fixture.policy())
        .json(&vote)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        operator
            .post(fixture.url(1, "/raft/vote"))
            .bearer_auth(TOKEN)
            .json(&vote)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let unknown = fixture.client(&fixture.unknown);
    assert_eq!(
        unknown
            .get(fixture.url(1, "/metrics"))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        operator
            .get(fixture.url(1, "/metrics"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );

    let root = reqwest::Certificate::from_der(fixture.pki.ca.der().as_ref()).unwrap();
    let anonymous = Client::builder()
        .tls_backend_rustls()
        .tls_certs_only([root.clone()])
        .resolve(&fixture.names[&1], fixture.peers[&1])
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    assert!(
        anonymous
            .get(fixture.url(1, "/metrics"))
            .bearer_auth(TOKEN)
            .send()
            .await
            .is_err()
    );
    let outsider_pki = Pki::new();
    let outsider = outsider_pki.issue("outsider.test", false, false);
    let outsider = fixture.client(&outsider);
    assert!(
        outsider
            .get(fixture.url(1, "/metrics"))
            .bearer_auth(TOKEN)
            .send()
            .await
            .is_err()
    );
    let expired = fixture.pki.issue("expired.test", false, true);
    assert!(
        fixture
            .client(&expired)
            .get(fixture.url(1, "/metrics"))
            .bearer_auth(TOKEN)
            .send()
            .await
            .is_err()
    );
    let mut swapped = fixture.peers.clone();
    swapped.insert(1, fixture.peers[&2]);
    let identity = format!(
        "{}\n{}",
        fixture.operator.cert_pem, fixture.operator.key_pem
    );
    let wrong_name = TlsTransport::client_builder(
        &[fixture.pki.ca.der().clone()],
        identity.as_bytes(),
        &fixture.names,
        &swapped,
    )
    .unwrap()
    .build()
    .unwrap();
    let wrong_url = format!(
        "https://{}:{}/metrics",
        fixture.names[&1],
        fixture.peers[&2].port()
    );
    assert!(
        wrong_name
            .get(wrong_url)
            .bearer_auth(TOKEN)
            .send()
            .await
            .is_err()
    );
    let mut plain = tokio::net::TcpStream::connect(fixture.peers[&1])
        .await
        .unwrap();
    plain
        .write_all(b"GET /metrics HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .await
        .unwrap();
    let mut bytes = [0; 512];
    if let Ok(Ok(length)) =
        tokio::time::timeout(Duration::from_secs(3), plain.read(&mut bytes)).await
    {
        assert!(!bytes[..length].starts_with(b"HTTP/"));
    }
    drop(plain);
    drop(first);
    let mut downgraded = fixture.start(1, false);
    let (status, message) = exited(&mut downgraded).await;
    assert!(!status.success());
    assert!(message.contains("策略"), "必须因持久传输策略而拒绝降级");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn certificate_rotation_preserves_authority_data_and_rejects_the_retired_identity() {
    let mut fixture = Fixture::new();
    let operator = fixture.client(&fixture.operator);
    let old_node = fixture.client(&fixture.nodes[&1]);
    let old_identity = serde_json::to_vec(
        TlsTransport::load(&fixture.tls(1), 1, &fixture.peers)
            .unwrap()
            .identity_policy(),
    )
    .unwrap();
    let mut settings = fixture.settings(1, true);
    settings["voters"] = json!([1]);
    let mut process = fixture.start_config(1, settings);
    ready(&fixture, &operator, 1, &mut process).await;
    assert_eq!(
        post(&fixture, &operator, 1, "/admin/initialize", &json!({}))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(leader(&fixture, &operator, &[1]).await, 1);
    let reply = post(
        &fixture,
        &operator,
        1,
        "/v1/rooms/commands",
        &command("before-rotation", "retained"),
    )
    .await
    .error_for_status()
    .unwrap()
    .json::<Value>()
    .await
    .unwrap();
    assert_eq!(reply["outcome"], "applied");
    drop(process);

    // 仅替换同CA、同名称的执行身份，不迁移或重写房间数据。
    let replacement = fixture.pki.issue(&fixture.names[&1], true, false);
    assert_ne!(
        fingerprint(replacement.cert.der().as_ref()),
        fixture.tls(1).peer_sha256[&1]
    );
    std::fs::write(
        fixture.directory.path().join("node-1.pem"),
        &replacement.cert_pem,
    )
    .unwrap();
    std::fs::write(
        fixture.directory.path().join("node-1.key"),
        &replacement.key_pem,
    )
    .unwrap();
    fixture.nodes.insert(1, replacement);
    let new_identity = serde_json::to_vec(
        TlsTransport::load(&fixture.tls(1), 1, &fixture.peers)
            .unwrap()
            .identity_policy(),
    )
    .unwrap();
    assert_ne!(old_identity, new_identity);
    let mut settings = fixture.settings(1, true);
    settings["voters"] = json!([1]);
    let mut process = fixture.start_config(1, settings);
    ready(&fixture, &operator, 1, &mut process).await;
    assert_eq!(leader(&fixture, &operator, &[1]).await, 1);
    let retained = operator
        .get(fixture.url(1, "/v1/rooms/tenant/retained"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(retained, reply["record"]);
    let replay = post(
        &fixture,
        &operator,
        1,
        "/v1/rooms/commands",
        &command("before-rotation", "retained"),
    )
    .await
    .error_for_status()
    .unwrap()
    .json::<Value>()
    .await
    .unwrap();
    assert_eq!(replay["outcome"], "duplicate");
    assert_eq!(replay["record"]["revision"], reply["record"]["revision"]);

    let vote = serde_json::to_value(openraft::raft::VoteRequest {
        vote: openraft::Vote::new(10, 1_u64),
        last_log_id: None,
    })
    .unwrap();
    let new_node = fixture.client(&fixture.nodes[&1]);
    for (client, expected) in [
        (&old_node, StatusCode::FORBIDDEN),
        (&new_node, StatusCode::OK),
    ] {
        assert_eq!(
            client
                .post(fixture.url(1, "/raft/vote"))
                .bearer_auth(TOKEN)
                .header("x-vs-room-policy", fixture.policy())
                .json(&vote)
                .send()
                .await
                .unwrap()
                .status(),
            expected
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mtls_media_admin_cli_preserves_preflight_single_write_readback_and_leader_failover() {
    let fixture = Fixture::new();
    let operator = fixture.client(&fixture.operator);
    let mut processes = BTreeMap::new();
    for id in 1..=3 {
        let mut settings = fixture.settings(id, true);
        settings["media_control"] = json!({
            "endpoints":{},"control_token":TOKEN,"dynamic_nodes":true,"node_draining":true
        });
        let mut process = fixture.start_config(id, settings);
        ready(&fixture, &operator, id, &mut process).await;
        processes.insert(id, process);
    }
    assert_eq!(
        post(&fixture, &operator, 1, "/admin/initialize", &json!({}))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    let primary = leader(&fixture, &operator, &[1, 2, 3]).await;
    let registered = post(
        &fixture,
        &operator,
        primary,
        "/v1/media-nodes/commands",
        &media_register(),
    )
    .await
    .error_for_status()
    .unwrap()
    .json::<Value>()
    .await
    .unwrap();
    let revision = registered["record"]["revision"].as_u64().unwrap();
    let assigned = post(
        &fixture,
        &operator,
        primary,
        "/v1/rooms/commands",
        &command("assign", "one"),
    )
    .await;
    assert_eq!(assigned.status(), StatusCode::OK);
    let order: Vec<_> = (1..=3)
        .filter(|id| *id != primary)
        .chain([primary])
        .collect();

    // 证书角色和Bearer错误都不能通过预览，因而不会进入写入路径。
    for identity in [&fixture.nodes[&1], &fixture.unknown] {
        let client = MediaAdmin::new(
            serde_json::from_value(fixture.admin_settings(identity, &order)).unwrap(),
        )
        .unwrap();
        assert!(
            client
                .apply(maintenance("denied", revision, true))
                .await
                .is_err()
        );
    }
    let settings = fixture.admin_settings(&fixture.operator, &order);
    let mut wrong_token = settings.clone();
    wrong_token["service_token"] = json!("wrong-private-service-token-with-enough-bytes");
    let client = MediaAdmin::new(serde_json::from_value(wrong_token.clone()).unwrap()).unwrap();
    assert!(
        client
            .apply(maintenance("denied-token", revision, true))
            .await
            .is_err()
    );
    let denied = admin_cli(&fixture, &wrong_token, "preview", "media").await;
    assert_eq!(denied.status.code(), Some(1));
    let mut wrong_names = settings.clone();
    for (index, name) in wrong_names["tls"]["server_names"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .enumerate()
    {
        *name = json!(format!("wrong-{index}.coordination.test"));
    }
    let client = MediaAdmin::new(serde_json::from_value(wrong_names).unwrap()).unwrap();
    assert!(
        client
            .apply(maintenance("wrong-server", revision, true))
            .await
            .is_err()
    );

    let preview = admin_cli(&fixture, &settings, "preview", "media").await;
    assert_eq!(
        preview.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&preview.stderr)
    );
    let view: Value = serde_json::from_slice(&preview.stdout).unwrap();
    assert_eq!(view["record"]["revision"], revision);
    assert_eq!(view["owned_rooms"].as_array().unwrap().len(), 1);
    let path = fixture.directory.path().join("maintenance-command.json");
    let argument = path.to_str().unwrap();
    let drain = maintenance("drain-cli", revision, true);
    std::fs::write(&path, serde_json::to_vec(&drain).unwrap()).unwrap();
    let unknown = admin_cli(&fixture, &settings, "confirm", argument).await;
    assert_eq!(unknown.status.code(), Some(3));
    let applied = admin_cli(&fixture, &settings, "apply", argument).await;
    assert_eq!(
        applied.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&applied.stderr)
    );
    let receipt: Value = serde_json::from_slice(&applied.stdout).unwrap();
    assert_eq!(receipt["outcome"], "confirmed");
    assert_eq!(receipt["writes_sent"], 1);
    let drained_revision = receipt["confirmed_record"]["revision"].as_u64().unwrap();
    assert!(drained_revision > revision);
    for mode in ["apply", "confirm"] {
        let output = admin_cli(&fixture, &settings, mode, argument).await;
        assert_eq!(output.status.code(), Some(0));
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["writes_sent"], 0);
        assert_eq!(value["confirmed_record"]["revision"], drained_revision);
    }
    std::fs::write(
        &path,
        serde_json::to_vec(&maintenance("stale", revision, false)).unwrap(),
    )
    .unwrap();
    let stale = admin_cli(&fixture, &settings, "apply", argument).await;
    assert_eq!(stale.status.code(), Some(2));
    assert_eq!(
        serde_json::from_slice::<Value>(&stale.stdout).unwrap()["writes_sent"],
        0
    );

    drop(processes.remove(&primary));
    let live: Vec<_> = processes.keys().copied().collect();
    let _replacement = leader(&fixture, &operator, &live).await;
    std::fs::write(
        &path,
        serde_json::to_vec(&maintenance("resume-cli", drained_revision, false)).unwrap(),
    )
    .unwrap();
    let resumed = admin_cli(&fixture, &settings, "apply", argument).await;
    assert_eq!(
        resumed.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&resumed.stderr)
    );
    let resumed_value: Value = serde_json::from_slice(&resumed.stdout).unwrap();
    assert_eq!(resumed_value["writes_sent"], 1);
    let resumed_record: vs_coordination::media_registry::MediaNodeRecord =
        serde_json::from_value(resumed_value["confirmed_record"].clone()).unwrap();
    assert!(!resumed_record.draining);
    assert!(
        resumed_value["confirmed_record"]["revision"]
            .as_u64()
            .unwrap()
            > drained_revision
    );
    let preview = admin_cli(&fixture, &settings, "preview", "media").await;
    let view: Value = serde_json::from_slice(&preview.stdout).unwrap();
    assert_eq!(view["owned_rooms"].as_array().unwrap().len(), 1);
    for output in [denied, unknown, applied, stale, resumed, preview] {
        for bytes in [output.stdout, output.stderr] {
            let text = String::from_utf8(bytes).unwrap();
            assert!(!text.contains(TOKEN));
            assert!(!text.contains("PRIVATE KEY"));
        }
    }
}

#[test]
fn media_admin_tls_rejects_bad_material_names_address_scope_and_missing_identity_before_io() {
    let fixture = Fixture::new();
    let good = fixture.admin_settings(&fixture.operator, &[1, 2, 3]);
    assert!(MediaAdmin::new(serde_json::from_value(good.clone()).unwrap()).is_ok());
    for case in [
        "missing-name",
        "extra-name",
        "duplicate-name",
        "url-name",
        "wrong-hash",
        "wrong-key",
        "wrong-ca",
        "expired",
        "server-only",
        "relative-key",
        "oversize-key",
        "public-address",
        "missing-tls",
    ] {
        let mut settings = good.clone();
        match case {
            "missing-name" => {
                settings["tls"]["server_names"]
                    .as_object_mut()
                    .unwrap()
                    .remove(&fixture.peers[&1].to_string());
            }
            "extra-name" => {
                let extra = (1..=u16::MAX)
                    .map(|port| SocketAddr::new(fixture.peers[&1].ip(), port))
                    .find(|address| !fixture.peers.values().any(|peer| peer == address))
                    .unwrap();
                settings["tls"]["server_names"][extra.to_string()] = json!("extra.test");
            }
            "duplicate-name" => {
                settings["tls"]["server_names"][fixture.peers[&1].to_string()] =
                    json!(fixture.names[&2]);
            }
            "url-name" => {
                settings["tls"]["server_names"][fixture.peers[&1].to_string()] =
                    json!("https://node.test/path");
            }
            "wrong-hash" => {
                settings["tls"]["certificate_sha256"] = json!("0".repeat(64));
            }
            "wrong-key" => {
                settings["tls"]["private_key_file"] =
                    json!(fixture.directory.path().join("node-2.key"));
            }
            "wrong-ca" => {
                let path = fixture.directory.path().join("other-ca.pem");
                std::fs::write(&path, pem("CERTIFICATE", Pki::new().ca.der().as_ref())).unwrap();
                settings["tls"]["ca_file"] = json!(path);
            }
            "expired" | "server-only" => {
                let identity = if case == "expired" {
                    fixture.pki.issue("expired-operator.test", false, true)
                } else {
                    let mut params =
                        CertificateParams::new(vec!["server-only.test".into()]).unwrap();
                    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
                    let key = KeyPair::generate().unwrap();
                    let cert = params.signed_by(&key, &fixture.pki.issuer).unwrap();
                    Identity {
                        cert_pem: pem("CERTIFICATE", cert.der().as_ref()),
                        key_pem: pem("PRIVATE KEY", &key.serialize_der()),
                        public_key_der: key.subject_public_key_info(),
                        cert,
                    }
                };
                settings = fixture.admin_settings(&identity, &[1, 2, 3]);
            }
            "relative-key" => {
                settings["tls"]["private_key_file"] = json!("relative.key");
            }
            "oversize-key" => {
                let path = fixture.directory.path().join("oversize.key");
                std::fs::write(&path, vec![b'x'; 65_537]).unwrap();
                settings["tls"]["private_key_file"] = json!(path);
            }
            "public-address" | "missing-tls" => {
                settings["endpoints"] = json!(["192.0.2.1:7443"]);
                settings["tls"]["server_names"] = json!({"192.0.2.1:7443":"node-1.test"});
                if case == "missing-tls" {
                    settings.as_object_mut().unwrap().remove("tls");
                    settings["endpoints"] = json!(["10.20.0.11:7443"]);
                }
            }
            _ => unreachable!(),
        }
        let config: MediaAdminConfig = serde_json::from_value(settings).unwrap();
        assert!(
            MediaAdmin::new(config).is_err(),
            "运维TLS配置应拒绝：{case}"
        );
        // 部分材料用例覆盖了固定临时文件，下一用例恢复有效身份。
        let _ = fixture.admin_settings(&fixture.operator, &[1, 2, 3]);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tls_media_admin_never_downgrades_to_a_plaintext_service() {
    let fixture = Fixture::new();
    let requests = Arc::new(AtomicUsize::new(0));
    let observed = requests.clone();
    let router = axum::Router::new().fallback(move || {
        let observed = observed.clone();
        async move {
            observed.fetch_add(1, Ordering::SeqCst);
            StatusCode::OK
        }
    });
    let listener = tokio::net::TcpListener::bind(fixture.peers[&1])
        .await
        .unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let config = serde_json::from_value(fixture.admin_settings(&fixture.operator, &[1])).unwrap();
    let client = MediaAdmin::new(config).unwrap();
    assert!(
        client
            .apply(maintenance("no-downgrade", 1, true))
            .await
            .is_err()
    );
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(4), task)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn media_reader_certificate_only_reads_assignments_owned_by_its_bound_node() {
    let fixture = Fixture::new();
    let reader_identity = fixture.pki.issue("media-reader.test", false, false);
    let reader = fixture.client(&reader_identity);
    let operator = fixture.client(&fixture.operator);
    let mut settings = fixture.settings(1, true);
    settings["voters"] = json!([1]);
    settings["tls"]["media_reader_sha256"] =
        json!({"media":fingerprint(reader_identity.cert.der().as_ref())});
    let mut process = fixture.start_config(1, settings);
    ready(&fixture, &operator, 1, &mut process).await;
    assert_eq!(
        post(&fixture, &operator, 1, "/admin/initialize", &json!({}))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(leader(&fixture, &operator, &[1]).await, 1);
    for (room, target) in [("owned", "media"), ("other", "other-media")] {
        let mut value = command(room, room);
        value["target"]["node_id"] = json!(target);
        assert_eq!(
            post(&fixture, &operator, 1, "/v1/rooms/commands", &value)
                .await
                .status(),
            StatusCode::OK
        );
    }
    let response = reader
        .get(fixture.url(1, "/v1/room-assignments/tenant/owned"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(response["record"]["owner"]["node_id"], "media");
    for (method, path) in [
        (reqwest::Method::GET, "/metrics"),
        (reqwest::Method::POST, "/admin/initialize"),
        (reqwest::Method::POST, "/raft/vote"),
        (reqwest::Method::GET, "/v1/rooms/tenant/owned"),
        (reqwest::Method::GET, "/v1/media-nodes/media/maintenance"),
        (reqwest::Method::GET, "/v1/room-assignments/tenant/other"),
        (reqwest::Method::GET, "/v1/room-assignments/tenant/missing"),
        (reqwest::Method::POST, "/v1/room-assignments/tenant/owned"),
    ] {
        let response = reader
            .request(method, fixture.url(1, path))
            .bearer_auth(TOKEN)
            .header("x-vs-role", "operator")
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "只读身份不得越权：{path}"
        );
    }
    assert_eq!(
        reader
            .get(fixture.url(1, "/v1/room-assignments/tenant/owned"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "需先构建vs-live并设置绝对路径VS_TEST_LIVE_BINARY；跨包真实进程验证单独执行"]
async fn real_media_process_verifies_private_mtls_authority_without_operator_privileges() {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use ring::signature::{Ed25519KeyPair, KeyPair};

    let binary = PathBuf::from(
        std::env::var_os("VS_TEST_LIVE_BINARY").expect("必须指定已构建的媒体程序绝对路径"),
    );
    assert!(
        binary.is_absolute() && binary.is_file(),
        "媒体程序路径必须绝对且存在"
    );
    let fixture = Fixture::new();
    let reader_identity = fixture.pki.issue("media-reader.test", false, false);
    let operator = fixture.client(&fixture.operator);
    let mut processes = BTreeMap::new();
    for id in 1..=3 {
        let mut settings = fixture.settings(id, true);
        settings["tls"]["media_reader_sha256"] =
            json!({"media":fingerprint(reader_identity.cert.der().as_ref())});
        let mut process = fixture.start_config(id, settings);
        ready(&fixture, &operator, id, &mut process).await;
        processes.insert(id, process);
    }
    assert_eq!(
        post(&fixture, &operator, 1, "/admin/initialize", &json!({}))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    let primary = leader(&fixture, &operator, &[1, 2, 3]).await;
    let order: Vec<_> = (1..=3)
        .filter(|id| *id != primary)
        .chain([primary])
        .collect();
    let client_settings = fixture.admin_settings(&reader_identity, &order);
    let access_path = fixture.directory.path().join("live-access.json");
    let control_path = fixture.directory.path().join("live-room-control.json");
    let key = Ed25519KeyPair::from_seed_unchecked(&[27; 32]).unwrap();
    std::fs::write(
        &access_path,
        serde_json::to_vec(&json!({
            "issuer":"https://media-test.invalid","audience":"live",
            "tenant_id":"tenant","room_id":"one","node_id":"media",
            "keys":[{"kid":"key","public_key":URL_SAFE_NO_PAD.encode(key.public_key().as_ref())}]
        }))
        .unwrap(),
    )
    .unwrap();
    const CONTROL_TOKEN: &str = "private-media-control-test-token-with-32-bytes";
    std::fs::write(&control_path, serde_json::to_vec(&json!({
        "cluster_id":"mtls-test","control_token":CONTROL_TOKEN,"coordination_token":TOKEN,
        "coordination_endpoints":order.iter().map(|id| format!("https://{}", fixture.peers[id])).collect::<Vec<_>>(),
        "coordination_tls":client_settings["tls"]
    })).unwrap()).unwrap();
    let address = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap();
    let mut command = Command::new(binary);
    command
        .env("VS_LIVE_BIND", address.to_string())
        .env("VS_LIVE_RUN_SECONDS", "60")
        .env("VS_LIVE_ACCESS_CONFIG", &access_path)
        .env("VS_LIVE_ROOM_CONTROL_CONFIG", &control_path)
        .env_remove("VS_LIVE_ROOMS_CONFIG")
        .env_remove("VS_LIVE_DRAIN_TLS_CONFIG")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut media = Process(command.spawn().unwrap());
    let local = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    let root = format!("http://{address}");
    let binding = tokio::time::timeout(Duration::from_secs(12), async {
        loop {
            if media.0.try_wait().unwrap().is_some() {
                let mut message = String::new();
                media
                    .0
                    .stderr
                    .take()
                    .unwrap()
                    .read_to_string(&mut message)
                    .unwrap();
                panic!("媒体程序提前退出：{message}");
            }
            if let Ok(response) = local.get(format!("{root}/lab/node")).send().await
                && response.status() == StatusCode::OK
                && let Ok(value) = response.json::<Value>().await
            {
                break value["binding"].clone();
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("媒体程序就绪超时");
    let target = json!({"node_id":"media","incarnation":binding["incarnation"]});
    let assignment = json!({
        "operation":"assign","tenant_id":"tenant","room_id":"one","operation_id":"initial",
        "expected_revision":null,"target":target
    });
    let first = post(
        &fixture,
        &operator,
        primary,
        "/v1/rooms/commands",
        &assignment,
    )
    .await
    .error_for_status()
    .unwrap()
    .json::<Value>()
    .await
    .unwrap();
    let revision = first["record"]["revision"].as_u64().unwrap();
    let fence = json!({"cluster_id":"mtls-test","tenant_id":"tenant","room_id":"one","target":target,"revision":revision});
    let activated = local
        .post(format!("{root}/admin/room/activate"))
        .bearer_auth(CONTROL_TOKEN)
        .json(&fence)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(activated["phase"], "active");
    assert_eq!(activated["fence"], fence);
    drop(processes.remove(&primary));
    let live: Vec<_> = processes.keys().copied().collect();
    let replacement = leader(&fixture, &operator, &live).await;
    let drained = local
        .post(format!("{root}/admin/room/drain"))
        .bearer_auth(CONTROL_TOKEN)
        .json(&fence)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(drained["phase"], "drained");
    assert_eq!(drained["active_peers"], 0);
    // 先取得真实媒体排空回执，再显式释放；本测试不验证自动排空连接器。
    let released = post(
        &fixture,
        &operator,
        replacement,
        "/v1/rooms/commands",
        &json!({
            "operation":"release","tenant_id":"tenant","room_id":"one","operation_id":"release",
            "expected_revision":revision,"target":target
        }),
    )
    .await
    .error_for_status()
    .unwrap()
    .json::<Value>()
    .await
    .unwrap();
    let reassigned = post(
        &fixture,
        &operator,
        replacement,
        "/v1/rooms/commands",
        &json!({
            "operation":"assign","tenant_id":"tenant","room_id":"one","operation_id":"reassign",
            "expected_revision":released["record"]["revision"],"target":target
        }),
    )
    .await
    .error_for_status()
    .unwrap()
    .json::<Value>()
    .await
    .unwrap();
    let new_revision = reassigned["record"]["revision"].as_u64().unwrap();
    assert!(new_revision > revision);
    let mut new_fence = fence.clone();
    new_fence["revision"] = json!(new_revision);
    let activated = local
        .post(format!("{root}/admin/room/activate"))
        .bearer_auth(CONTROL_TOKEN)
        .json(&new_fence)
        .send()
        .await
        .unwrap();
    assert_eq!(activated.status(), StatusCode::OK);
    let old = local
        .post(format!("{root}/admin/room/activate"))
        .bearer_auth(CONTROL_TOKEN)
        .json(&fence)
        .send()
        .await
        .unwrap();
    assert_eq!(old.status(), StatusCode::CONFLICT);
    let other = *processes.keys().find(|id| **id != replacement).unwrap();
    drop(processes.remove(&other));
    let unavailable = local
        .post(format!("{root}/admin/room/activate"))
        .bearer_auth(CONTROL_TOKEN)
        .json(&new_fence)
        .send()
        .await
        .unwrap();
    assert_eq!(unavailable.status(), StatusCode::SERVICE_UNAVAILABLE);
    let stats = local
        .get(format!("{root}/lab/metrics"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(stats["assignment_revision"], new_revision);
    assert_eq!(stats["accepted_sessions"], 0);
    let udp_port = stats["udp_port"].as_u64().unwrap() as u16;
    drop(media);
    assert!(std::net::UdpSocket::bind(("127.0.0.1", udp_port)).is_ok());
    println!(
        "媒体权威mTLS验证：{}",
        json!({
            "schema":"media-authority-mtls-lab-v1","coordination_bind":fixture.peers[&1].ip(),
            "coordinators":3,"media_processes":1,"physical_hosts":1,
            "node_readonly_identity":true,"leader_failover":true,"new_revision_gt_old":true,
            "stale_activation_status":409,"lost_quorum_activation_status":503,
            "media_http_and_udp_loopback":true,"automatic_media_release_connector_verified":false,
            "rtc_sessions":0,"media_process_reclaimed":true
        })
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tls_maintenance_lost_responses_timeout_redirect_and_overwrite_never_resend_a_write() {
    use axum::{
        Json, Router,
        extract::Extension,
        response::{IntoResponse, Response},
        routing::{get, post},
    };
    use vs_coordination::tls::ClientRole;
    for mode in 0..6 {
        let fixture = Fixture::new();
        let mut data = StateData::default();
        apply_authority(
            &mut data,
            AuthorityCommand::Media(serde_json::from_value(media_register()).unwrap()),
            1,
            true,
        );
        let data = Arc::new(tokio::sync::Mutex::new(data));
        let reads = Arc::new(AtomicUsize::new(0));
        let writes = Arc::new(AtomicUsize::new(0));
        let read_data = data.clone();
        let read_count = reads.clone();
        let read_writes = writes.clone();
        let write_count = writes.clone();
        let write_data = data.clone();
        let router = Router::new()
            .route(
                "/v1/media-nodes/media/maintenance",
                get(move |Extension(role): Extension<ClientRole>| {
                    let (data, reads, writes) =
                        (read_data.clone(), read_count.clone(), read_writes.clone());
                    async move {
                        assert_eq!(role, ClientRole::Operator);
                        reads.fetch_add(1, Ordering::SeqCst);
                        if mode == 5 && writes.load(Ordering::SeqCst) != 0 {
                            return StatusCode::FORBIDDEN.into_response();
                        }
                        Json(MaintenanceView {
                            cluster_id: "mtls-test".into(),
                            node_id: "media".into(),
                            record: data.lock().await.media_nodes.get("media").cloned(),
                            owned_rooms: vec![],
                        })
                        .into_response()
                    }
                }),
            )
            .route(
                "/v1/media-nodes/commands",
                post(
                    move |Extension(role): Extension<ClientRole>,
                          Json(command): Json<MediaNodeCommand>| {
                        let (data, writes) = (write_data.clone(), write_count.clone());
                        async move {
                            assert_eq!(role, ClientRole::Operator);
                            writes.fetch_add(1, Ordering::SeqCst);
                            let mut data = data.lock().await;
                            let AuthorityReply::Media(reply) = apply_authority(
                                &mut data,
                                AuthorityCommand::Media(command),
                                2,
                                true,
                            ) else {
                                panic!("媒体命令类型错误");
                            };
                            if mode == 2 {
                                apply_authority(
                                    &mut data,
                                    AuthorityCommand::Media(maintenance("later", 2, false)),
                                    3,
                                    true,
                                );
                            }
                            drop(data);
                            match mode {
                                0 | 2 | 5 => StatusCode::SERVICE_UNAVAILABLE.into_response(),
                                1 => {
                                    tokio::time::sleep(Duration::from_millis(1800)).await;
                                    Json(reply).into_response()
                                }
                                3 => (
                                    StatusCode::TEMPORARY_REDIRECT,
                                    [("location", "/v1/media-nodes/commands")],
                                )
                                    .into_response(),
                                4 => Response::builder()
                                    .status(200)
                                    .body(axum::body::Body::from("{"))
                                    .unwrap(),
                                _ => unreachable!(),
                            }
                        }
                    },
                ),
            );
        let transport = TlsTransport::load(&fixture.tls(1), 1, &fixture.peers).unwrap();
        let listener = tokio::net::TcpListener::bind(fixture.peers[&1])
            .await
            .unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            transport
                .serve(listener, router, async {
                    let _ = stopped.await;
                })
                .await
        });
        let config =
            serde_json::from_value(fixture.admin_settings(&fixture.operator, &[1])).unwrap();
        let receipt = MediaAdmin::new(config)
            .unwrap()
            .apply(maintenance("fault-check", 1, true))
            .await
            .unwrap();
        assert_eq!(receipt.writes_sent, 1, "故障模式：{mode}");
        assert_eq!(
            writes.load(Ordering::SeqCst),
            1,
            "不得因TLS响应异常重发：{mode}"
        );
        assert_eq!(reads.load(Ordering::SeqCst), 2);
        if matches!(mode, 2 | 5) {
            assert!(matches!(receipt.outcome, MaintenanceOutcome::Unknown));
            assert!(receipt.confirmed_record.is_none());
        } else {
            assert!(matches!(receipt.outcome, MaintenanceOutcome::Confirmed));
        }
        stop.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(4), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}

#[test]
fn tls_material_and_identity_configuration_reject_ambiguity_before_startup() {
    let fixture = Fixture::new();
    assert!(TlsTransport::load(&fixture.tls(1), 1, &fixture.peers).is_ok());
    for case in [
        "empty-operator",
        "duplicate-role",
        "wrong-key",
        "wrong-leaf",
        "bad-name",
        "missing-peer",
        "bad-ca",
        "relative-key",
        "oversize-key",
        "duplicate-media-role",
        "bad-media-node",
        "duplicate-profile-role",
        "bad-profile-reader",
        "too-many-profile-readers",
    ] {
        let mut config = fixture.tls(1);
        match case {
            "empty-operator" => config.operator_sha256.clear(),
            "duplicate-role" => config.operator_sha256 = vec![config.peer_sha256[&1].clone()],
            "wrong-key" => config.private_key_file = fixture.tls(2).private_key_file,
            "wrong-leaf" => config.certificate_file = fixture.tls(2).certificate_file,
            "bad-name" => {
                config.server_names.insert(1, "node/user@elsewhere".into());
            }
            "missing-peer" => {
                config.peer_sha256.remove(&4);
            }
            "bad-ca" => {
                let path = fixture.directory.path().join("bad-ca");
                std::fs::write(&path, b"invalid").unwrap();
                config.ca_file = path;
            }
            "relative-key" => config.private_key_file = PathBuf::from("private.key"),
            "oversize-key" => {
                let path = fixture.directory.path().join("big-key");
                std::fs::write(&path, vec![b'x'; 65_537]).unwrap();
                config.private_key_file = path;
            }
            "duplicate-media-role" => {
                config
                    .media_reader_sha256
                    .insert("media".into(), config.operator_sha256[0].clone());
            }
            "bad-media-node" => {
                config.media_reader_sha256.insert(
                    "..".into(),
                    fingerprint(fixture.unknown.cert.der().as_ref()),
                );
            }
            "duplicate-profile-role" => {
                config
                    .profile_reader_sha256
                    .insert("feed".into(), config.operator_sha256[0].clone());
            }
            "bad-profile-reader" => {
                config.profile_reader_sha256.insert(
                    "..".into(),
                    fingerprint(fixture.unknown.cert.der().as_ref()),
                );
            }
            "too-many-profile-readers" => {
                for index in 0..17 {
                    config
                        .profile_reader_sha256
                        .insert(format!("feed-{index}"), format!("{index:064x}"));
                }
            }
            _ => unreachable!(),
        }
        assert!(
            TlsTransport::load(&config, 1, &fixture.peers).is_err(),
            "配置拒绝失败：{case}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tls_shutdown_reclaims_stalled_handshakes_without_detached_connections() {
    let fixture = Fixture::new();
    let transport = TlsTransport::load(&fixture.tls(1), 1, &fixture.peers).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        transport
            .serve(listener, axum::Router::new(), async {
                let _ = stopped.await;
            })
            .await
    });
    let mut streams = Vec::new();
    for _ in 0..32 {
        streams.push(tokio::net::TcpStream::connect(address).await.unwrap());
    }
    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    drop(streams);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tls_release_requires_the_exact_drained_zero_peer_receipt_without_resending() {
    use axum::{
        Json, Router,
        extract::Extension,
        response::{IntoResponse, Response},
        routing::post as route_post,
    };
    use vs_tls::VerifiedPeer;
    let fixture = Fixture::new();
    let identity = fixture.pki.issue("media.control.test", true, false);
    let server: vs_tls::FixedServerTls =
        serde_json::from_value(server_settings(&fixture, &identity)).unwrap();
    let listener = loop {
        let listener = tokio::net::TcpListener::bind(SocketAddr::new(fixture.peers[&1].ip(), 0))
            .await
            .unwrap();
        if !fixture
            .peers
            .values()
            .any(|peer| *peer == listener.local_addr().unwrap())
        {
            break listener;
        }
    };
    let endpoint = listener.local_addr().unwrap();
    let mode = Arc::new(AtomicUsize::new(0));
    let posts = Arc::new(AtomicUsize::new(0));
    let (route_mode, route_posts) = (mode.clone(), posts.clone());
    let expected_peer = fingerprint(fixture.nodes[&1].cert.der().as_ref());
    let app = Router::new().route(
        "/admin/room/drain",
        route_post(
            move |Extension(peer): Extension<VerifiedPeer>, Json(fence): Json<Value>| {
                let (mode, posts, expected) = (
                    route_mode.clone(),
                    route_posts.clone(),
                    expected_peer.clone(),
                );
                async move {
                    assert_eq!(peer.sha256(), expected);
                    posts.fetch_add(1, Ordering::SeqCst);
                    let selected = mode.load(Ordering::SeqCst);
                    let mut receipt = json!({"fence":fence,"phase":"drained","active_peers":0});
                    match selected {
                        0 => receipt["phase"] = json!("active"),
                        1 => receipt["active_peers"] = json!(1),
                        2 => {
                            receipt["fence"]["target"]["incarnation"] =
                                json!("different-incarnation")
                        }
                        3 => {
                            return Response::builder()
                                .status(200)
                                .body(axum::body::Body::from("{"))
                                .unwrap();
                        }
                        4 => return (StatusCode::OK, "x".repeat(8193)).into_response(),
                        5 => tokio::time::sleep(Duration::from_millis(1800)).await,
                        6 => {
                            return (
                                StatusCode::TEMPORARY_REDIRECT,
                                [("location", "/admin/room/drain")],
                            )
                                .into_response();
                        }
                        7 => {}
                        _ => unreachable!(),
                    }
                    Json(receipt).into_response()
                }
            },
        ),
    );
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        vs_tls::serve_mtls(server.load().unwrap(), listener, app, async {
            let _ = stopped.await;
        })
        .await
    });
    let mut settings = fixture.settings(1, true);
    settings["voters"] = json!([1]);
    settings["media_control"] = release_settings(&fixture, 1, endpoint);
    let operator = fixture.client(&fixture.operator);
    let mut process = fixture.start_config(1, settings);
    ready(&fixture, &operator, 1, &mut process).await;
    assert_eq!(
        post(&fixture, &operator, 1, "/admin/initialize", &json!({}))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(leader(&fixture, &operator, &[1]).await, 1);
    for selected in 0..8 {
        mode.store(selected, Ordering::SeqCst);
        let room = format!("fault-{selected}");
        let assigned = post(
            &fixture,
            &operator,
            1,
            "/v1/rooms/commands",
            &command(&room, &room),
        )
        .await
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
        let release = json!({"operation":"release","tenant_id":"tenant","room_id":room,
            "operation_id":format!("release-{selected}"),"expected_revision":assigned["record"]["revision"],"target":assigned["record"]["owner"]});
        // 观测端需覆盖内部1.5秒期限，不改变被测连接器的超时和单次请求语义。
        let response = operator
            .post(fixture.url(1, "/v1/rooms/commands"))
            .bearer_auth(TOKEN)
            .json(&release)
            .timeout(Duration::from_secs(4))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            if selected == 7 {
                StatusCode::OK
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            },
            "回执故障模式：{selected}"
        );
        let retained = operator
            .get(fixture.url(1, &format!("/v1/rooms/tenant/{room}")))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        if selected == 7 {
            assert!(retained["owner"].is_null());
        } else {
            assert_eq!(
                retained, assigned["record"],
                "未确认排空不得改变归属：{selected}"
            );
        }
        assert_eq!(
            posts.load(Ordering::SeqCst),
            selected + 1,
            "不得重发排空请求：{selected}"
        );
    }
    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(4), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "需独立vs-live程序，使用TLS排空集成脚本显式执行"]
async fn real_tls_release_connector_drains_media_before_committing_owner_change() {
    exercise_tls_release_connector(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "需独立vs-live程序，使用动态TLS登记脚本显式执行"]
async fn real_dynamic_tls_registry_joins_and_drains_without_coordinator_restart() {
    exercise_tls_release_connector(true).await;
}

async fn exercise_tls_release_connector(dynamic_registry: bool) {
    let fixture = Fixture::new();
    let server_identity = fixture.pki.issue("media.control.test", true, false);
    let reader = fixture.pki.issue("media-reader.test", false, false);
    let reservation = loop {
        let listener =
            std::net::TcpListener::bind(SocketAddr::new(fixture.peers[&1].ip(), 0)).unwrap();
        if !fixture
            .peers
            .values()
            .any(|peer| *peer == listener.local_addr().unwrap())
        {
            break listener;
        }
    };
    let endpoint = reservation.local_addr().unwrap();
    let server = server_settings(&fixture, &server_identity);
    let drain_config = json!({"bind":endpoint,"server":server,"coordinator_sha256":
        (1..=3).map(|id|fingerprint(fixture.nodes[&id].cert.der().as_ref())).collect::<Vec<_>>()});
    let operator = fixture.client(&fixture.operator);
    let mut processes = BTreeMap::new();
    for id in 1..=3 {
        let mut settings = fixture.settings(id, true);
        settings["tls"]["media_reader_sha256"] =
            json!({"media":fingerprint(reader.cert.der().as_ref())});
        settings["media_control"] = release_settings(&fixture, id, endpoint);
        if dynamic_registry {
            settings["media_control"]["dynamic_nodes"] = json!(true);
            settings["media_control"]["node_draining"] = json!(true);
        }
        let mut process = fixture.start_config(id, settings);
        ready(&fixture, &operator, id, &mut process).await;
        processes.insert(id, process);
    }
    assert_eq!(
        post(&fixture, &operator, 1, "/admin/initialize", &json!({}))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    let primary = leader(&fixture, &operator, &[1, 2, 3]).await;
    let order: Vec<_> = (1..=3)
        .filter(|id| *id != primary)
        .chain([primary])
        .collect();
    drop(reservation);
    let (mut media, address, binding, local) =
        start_live(&fixture, &reader, &order, Some(drain_config)).await;
    let root = format!("http://{address}");
    let target = json!({"node_id":"media","incarnation":binding["incarnation"]});
    if dynamic_registry {
        let registration = json!({
            "operation":"register_media","operation_id":"online-join","expected_revision":null,
            "registration":{"target":target,"endpoint":endpoint,"transport":"mtls_v1",
                "rooms":[{"tenant_id":"tenant","room_id":"one"}]}
        });
        let mut unregistered = command("before-register", "one");
        unregistered["target"] = target.clone();
        assert_eq!(
            post(
                &fixture,
                &operator,
                primary,
                "/v1/rooms/commands",
                &unregistered
            )
            .await
            .json::<Value>()
            .await
            .unwrap()["outcome"],
            "unregistered"
        );
        for change in ["unknown-node", "unknown-address", "plaintext"] {
            let mut wrong = registration.clone();
            match change {
                "unknown-node" => wrong["registration"]["target"]["node_id"] = json!("unlisted"),
                "unknown-address" => {
                    wrong["registration"]["endpoint"] = json!("10.254.253.252:7443")
                }
                "plaintext" => {
                    wrong["registration"]
                        .as_object_mut()
                        .unwrap()
                        .remove("transport");
                }
                _ => unreachable!(),
            }
            assert_eq!(
                post(
                    &fixture,
                    &operator,
                    primary,
                    "/v1/media-nodes/commands",
                    &wrong
                )
                .await
                .status(),
                StatusCode::BAD_REQUEST,
                "{change}"
            );
        }
        let registered = post(
            &fixture,
            &operator,
            primary,
            "/v1/media-nodes/commands",
            &registration,
        )
        .await
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
        assert_eq!(registered["outcome"], "applied");
        assert_eq!(
            registered["record"]["registration"],
            registration["registration"]
        );
        let view = operator
            .get(fixture.url(primary, "/v1/media-nodes/media/maintenance"))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap();
        assert_eq!(view.status(), StatusCode::OK);
    }
    let mut assign = command("assign", "one");
    assign["target"] = target.clone();
    let accepted = post(&fixture, &operator, primary, "/v1/rooms/commands", &assign)
        .await
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    let revision = accepted["record"]["revision"].as_u64().unwrap();
    let mut maintenance_state = None;
    if dynamic_registry {
        let admin = MediaAdmin::new(
            serde_json::from_value(fixture.admin_settings(&fixture.operator, &[primary])).unwrap(),
        )
        .unwrap();
        let view = admin.preview("media").await.unwrap();
        let registration_revision = view.record.unwrap().revision;
        assert_eq!(view.owned_rooms.len(), 1);
        let remove = json!({
            "operation":"remove_media","operation_id":"remove-owned",
            "expected_revision":registration_revision,"target":target
        });
        let denied = post(
            &fixture,
            &operator,
            primary,
            "/v1/media-nodes/commands",
            &remove,
        )
        .await;
        assert_eq!(denied.status(), StatusCode::CONFLICT);
        assert_eq!(denied.json::<Value>().await.unwrap()["outcome"], "in_use");
        let pause: MediaNodeCommand = serde_json::from_value(json!({
            "operation":"set_media_draining","operation_id":"pause-online-node",
            "expected_revision":registration_revision,"target":target,"draining":true
        }))
        .unwrap();
        let receipt = admin.apply(pause).await.unwrap();
        assert!(matches!(receipt.outcome, MaintenanceOutcome::Confirmed));
        assert_eq!(receipt.writes_sent, 1);
        let record = receipt.confirmed_record.unwrap();
        assert!(record.draining);
        maintenance_state = Some((admin, record.revision));
    }
    let fence = json!({"cluster_id":"mtls-test","tenant_id":"tenant","room_id":"one","target":target,"revision":revision});
    assert_eq!(
        local
            .post(format!("{root}/admin/room/activate"))
            .bearer_auth(CONTROL_TOKEN)
            .json(&fence)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let url = format!(
        "https://media.control.test:{}/admin/room/drain",
        endpoint.port()
    );
    for identity in [&fixture.operator, &reader, &fixture.unknown] {
        let denied = control_client(&fixture, identity, endpoint)
            .post(&url)
            .bearer_auth(CONTROL_TOKEN)
            .header("x-vs-role", "coordinator")
            .json(&fence)
            .send()
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    }
    let coordinator = control_client(&fixture, &fixture.nodes[&1], endpoint);
    assert_eq!(
        coordinator
            .post(&url)
            .json(&fence)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        coordinator
            .get(format!(
                "https://media.control.test:{}/lab/metrics",
                endpoint.port()
            ))
            .bearer_auth(CONTROL_TOKEN)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let mut wrong = fence.clone();
    wrong["target"]["incarnation"] = json!("incorrect-incarnation");
    assert_eq!(
        coordinator
            .post(&url)
            .bearer_auth(CONTROL_TOKEN)
            .json(&wrong)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    let mut release = json!({"operation":"release","tenant_id":"tenant","room_id":"one",
        "operation_id":"release","expected_revision":revision,"target":target});
    let released = post(&fixture, &operator, primary, "/v1/rooms/commands", &release)
        .await
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(released["outcome"], "applied");
    assert!(released["record"]["owner"].is_null());
    let stats = local
        .get(format!("{root}/lab/metrics"))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(stats["drained_revision"], revision);
    assert!(stats["assignment_revision"].is_null());
    assert_eq!(stats["accepted_sessions"], 0);
    let duplicate = post(&fixture, &operator, primary, "/v1/rooms/commands", &release)
        .await
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(duplicate["outcome"], "duplicate");
    assert_eq!(
        duplicate["record"]["revision"],
        released["record"]["revision"]
    );
    if let Some((admin, registration_revision)) = maintenance_state {
        let resume: MediaNodeCommand = serde_json::from_value(json!({
            "operation":"set_media_draining","operation_id":"resume-online-node",
            "expected_revision":registration_revision,"target":target,"draining":false
        }))
        .unwrap();
        let receipt = admin.apply(resume).await.unwrap();
        assert!(matches!(receipt.outcome, MaintenanceOutcome::Confirmed));
        assert_eq!(receipt.writes_sent, 1);
        assert!(!receipt.confirmed_record.unwrap().draining);
    }
    drop(processes.remove(&primary));
    let live: Vec<_> = processes.keys().copied().collect();
    let replacement = leader(&fixture, &operator, &live).await;
    assign["expected_revision"] = released["record"]["revision"].clone();
    assign["operation_id"] = json!("reassign");
    let next = post(
        &fixture,
        &operator,
        replacement,
        "/v1/rooms/commands",
        &assign,
    )
    .await
    .error_for_status()
    .unwrap()
    .json::<Value>()
    .await
    .unwrap();
    let next_revision = next["record"]["revision"].as_u64().unwrap();
    let mut next_fence = fence.clone();
    next_fence["revision"] = json!(next_revision);
    assert_eq!(
        local
            .post(format!("{root}/admin/room/activate"))
            .bearer_auth(CONTROL_TOKEN)
            .json(&next_fence)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let udp_port = stats["udp_port"].as_u64().unwrap() as u16;
    let status = tokio::time::timeout(Duration::from_secs(40), async {
        loop {
            if let Some(status) = media.0.try_wait().unwrap() {
                break status;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("媒体双监听未在期限内自行停机");
    assert!(status.success(), "媒体双监听正常停机失败");
    drop(media);
    release["operation_id"] = json!("unavailable");
    release["expected_revision"] = json!(next_revision);
    assert_eq!(
        post(
            &fixture,
            &operator,
            replacement,
            "/v1/rooms/commands",
            &release
        )
        .await
        .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    let retained = operator
        .get(fixture.url(replacement, "/v1/rooms/tenant/one"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(retained, next["record"]);
    assert!(std::net::UdpSocket::bind(("127.0.0.1", udp_port)).is_ok());
    if dynamic_registry {
        // 目录或名称变更不能借重启绕过已持久化的业务策略。
        for change in ["directory", "server-name"] {
            let mut settings = fixture.settings(primary, true);
            settings["media_control"] = release_settings(&fixture, primary, endpoint);
            settings["media_control"]["dynamic_nodes"] = json!(true);
            settings["media_control"]["node_draining"] = json!(true);
            match change {
                "directory" => {
                    settings["media_control"]["endpoints"]["future-media"] =
                        json!("10.254.253.251:7444");
                    settings["media_control"]["tls"]["server_names"]["10.254.253.251:7444"] =
                        json!("future-media.control.test");
                }
                "server-name" => {
                    settings["media_control"]["tls"]["server_names"][endpoint.to_string()] =
                        json!("changed-media.control.test");
                }
                _ => unreachable!(),
            }
            let mut rejected = fixture.start_config(primary, settings);
            let (status, diagnostic) = exited(&mut rejected).await;
            assert!(!status.success(), "{change}");
            assert!(diagnostic.contains("策略"), "{change}：{diagnostic}");
        }
    }
    let prefix = if dynamic_registry {
        "动态TLS登记闭环验证"
    } else {
        "TLS排空闭环验证"
    };
    println!(
        "{prefix}：{}",
        json!({
            "schema":if dynamic_registry {"media-registry-mtls-lab-v1"} else {"media-drain-mtls-lab-v1"},
            "coordination_bind":fixture.peers[&1].ip(),
            "drain_bind":endpoint.ip(),"coordinators":3,"media_processes":1,"physical_hosts":1,
            "automatic_tls_release":true,"leader_failover":true,"lost_media_keeps_owner":true,
            "unauthorized_certificates_denied":true,"media_http_udp_loopback":true,"rtc_sessions":0,"process_reclaimed":true,
            "graceful_dual_listener_shutdown":true,
            "online_registry_join":dynamic_registry,"unlisted_destinations_denied":dynamic_registry,
            "maintenance_and_in_use_verified":dynamic_registry,
            "directory_change_rejected_on_reopen":dynamic_registry,
            "new_trust_slots_require_explicit_migration":dynamic_registry
        })
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "需独立vs-live和明确私网接口；使用HTTPS信令实验脚本显式执行"]
async fn real_https_signaling_keeps_native_clients_separate_from_media_administration() {
    use base64::{
        Engine,
        engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    };
    use ring::signature::Ed25519KeyPair;
    use sha2::{Digest, Sha256};
    let fixture = Fixture::new();
    let browser_dir = std::env::var_os("VS_TEST_SIGNALING_BROWSER_DIR").map(PathBuf::from);
    let relay_requested = std::env::var("VS_TEST_TURN_RELAY").as_deref() == Ok("1");
    assert!(
        !relay_requested || browser_dir.is_some(),
        "TURN模式必须有真实浏览器验证"
    );
    let ip = fixture.peers[&1].ip();
    assert!(
        match ip {
            std::net::IpAddr::V4(ip) => ip.is_private(),
            std::net::IpAddr::V6(ip) => ip.is_unique_local(),
        },
        "此实验须指定实际私网接口，不能以回环替代"
    );
    let signal_reservation = std::net::TcpListener::bind(SocketAddr::new(ip, 0)).unwrap();
    let endpoint = signal_reservation.local_addr().unwrap();
    let udp_reservation = std::net::UdpSocket::bind(SocketAddr::new(ip, 0)).unwrap();
    let udp = udp_reservation.local_addr().unwrap();
    let server_identity = fixture.pki.issue("media.control.test", true, false);
    let server = server_settings(&fixture, &server_identity);
    let reader = fixture.pki.issue("media-reader.test", false, false);
    let operator = fixture.client(&fixture.operator);
    let mut processes = BTreeMap::new();
    for id in 1..=3 {
        let mut settings = fixture.settings(id, true);
        settings["tls"]["media_reader_sha256"] =
            json!({"media":fingerprint(reader.cert.der().as_ref())});
        let mut process = fixture.start_config(id, settings);
        ready(&fixture, &operator, id, &mut process).await;
        processes.insert(id, process);
    }
    assert_eq!(
        post(&fixture, &operator, 1, "/admin/initialize", &json!({}))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    let primary = leader(&fixture, &operator, &[1, 2, 3]).await;
    drop(signal_reservation);
    drop(udp_reservation);
    let mut config = json!({
        "bind":endpoint,"server":server,"allowed_origins":[],
        "media":{"bind":udp,"peer_ips":[ip]}
    });
    let mut turn = None;
    let mut turn_addresses = Vec::new();
    let mut turn_metadata = json!({});
    if relay_requested {
        use ring::rand::{SecureRandom, SystemRandom};
        let std::net::IpAddr::V4(client_ip) = ip else {
            panic!("当前TURN实验只支持IPv4");
        };
        let reservations: Vec<_> = (0..9)
            .map(|_| std::net::UdpSocket::bind(SocketAddr::new(ip, 0)).unwrap())
            .collect();
        let bind = reservations[0].local_addr().unwrap();
        let relay_ports: Vec<_> = reservations[1..]
            .iter()
            .map(|socket| socket.local_addr().unwrap().port())
            .collect();
        turn_addresses.push(bind);
        turn_addresses.extend(relay_ports.iter().map(|port| SocketAddr::new(ip, *port)));
        drop(reservations);
        let mut secret = [0; 32];
        SystemRandom::new().fill(&mut secret).unwrap();
        let password = URL_SAFE_NO_PAD.encode(secret);
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let handle = TurnProcess::start(&json!({
            "bind":bind,"relay_ports":relay_ports,"client_ips":[client_ip],"peers":[udp],
            "realm":"media-relay.test","credentials":[{"username":"browser","password":password}],
            "expires_unix_seconds":at+180
        }), fixture.directory.path()).await;
        config["client_ice"] = json!({
            "expires_unix_seconds":at+180,
            "servers":[{"url":format!("turn:{bind}?transport=udp"),"username":"browser","credential":password}]
        });
        turn_metadata = json!({"bind":bind,"ports":relay_ports,"pid":handle.ready["pid"]});
        turn = Some(handle);
    }
    let (mut media, address, binding, local) =
        start_live_signaling(&fixture, &reader, &[primary], None, Some(config)).await;
    let root = format!("http://{address}");
    let signal_root = format!("https://media.control.test:{}", endpoint.port());
    let native = Client::builder()
        .tls_backend_rustls()
        .tls_certs_only([reqwest::Certificate::from_der(fixture.pki.ca.der().as_ref()).unwrap()])
        .resolve("media.control.test", endpoint)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(Duration::from_secs(4))
        .build()
        .unwrap();
    let target = json!({"node_id":"media","incarnation":binding["incarnation"]});
    let mut assign = command("assign-signal", "one");
    assign["target"] = target.clone();
    let accepted = post(&fixture, &operator, primary, "/v1/rooms/commands", &assign)
        .await
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    let revision = accepted["record"]["revision"].as_u64().unwrap();
    let fence = json!({"cluster_id":"mtls-test","tenant_id":"tenant","room_id":"one","target":target,"revision":revision});
    assert_eq!(
        local
            .post(format!("{root}/admin/room/activate"))
            .bearer_auth(CONTROL_TOKEN)
            .json(&fence)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let mint = |subject: &str, role: &str| {
        let key = Ed25519KeyPair::from_seed_unchecked(&[27; 32]).unwrap();
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"EdDSA","typ":"vs-live+jwt","kid":"key"}"#);
        let mut claims = binding.clone();
        for (name, value) in [
            ("iss", json!("https://media-test.invalid")),
            ("aud", json!("live")),
            ("sub", json!(subject)),
            ("iat", json!(at)),
            ("nbf", json!(at)),
            ("exp", json!(at + 120)),
            ("role", json!(role)),
            ("assignment_revision", json!(revision)),
        ] {
            claims[name] = value;
        }
        let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        let input = format!("{header}.{body}");
        format!(
            "{input}.{}",
            URL_SAFE_NO_PAD.encode(key.sign(input.as_bytes()).as_ref())
        )
    };
    let publisher = mint("alice", "publisher");
    let subscriber = mint("bob", "subscriber");
    if relay_requested {
        for token in [None, Some(CONTROL_TOKEN), Some(subscriber.as_str())] {
            let mut request =
                native.request(reqwest::Method::OPTIONS, format!("{signal_root}/whip"));
            if let Some(token) = token {
                request = request.bearer_auth(token);
            }
            let response = request.send().await.unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            assert!(!response.headers().contains_key("link"));
        }
        for (endpoint, token) in [("whip", &publisher), ("whep", &subscriber)] {
            let response = native
                .request(
                    reqwest::Method::OPTIONS,
                    format!("{signal_root}/{endpoint}"),
                )
                .bearer_auth(token)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()["cache-control"], "no-store");
            assert_eq!(response.headers().get_all("link").iter().count(), 1);
            assert!(
                response.headers()["link"]
                    .to_str()
                    .unwrap()
                    .starts_with(&format!(
                        "<turn:{}?transport=udp>",
                        turn_metadata["bind"].as_str().unwrap()
                    ))
            );
            assert!(
                response.headers()["x-vs-ice-expires"]
                    .to_str()
                    .unwrap()
                    .parse::<u64>()
                    .unwrap()
                    > 0
            );
        }
    }
    for path in [
        "/",
        "/app.js",
        "/lab/metrics",
        "/lab/node",
        "/admin/room/activate",
        "/admin/room/drain",
        "/admin/room/revoke-token",
    ] {
        assert_eq!(
            native
                .post(format!("{signal_root}{path}"))
                .bearer_auth(CONTROL_TOKEN)
                .json(&fence)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND,
            "{path}"
        );
    }
    assert_eq!(
        native
            .post(format!("{signal_root}/whip"))
            .header("content-type", "application/sdp")
            .body("invalid")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        native
            .post(format!("{signal_root}/whep"))
            .bearer_auth(&publisher)
            .header("content-type", "application/sdp")
            .body("invalid")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let preflight = native
        .request(reqwest::Method::OPTIONS, format!("{signal_root}/whip"))
        .header("origin", "https://app.example")
        .header("access-control-request-method", "POST")
        .header(
            "access-control-request-headers",
            "authorization, content-type",
        )
        .send()
        .await
        .unwrap();
    assert_eq!(preflight.status(), StatusCode::OK);
    assert_eq!(
        preflight.headers()["access-control-allow-origin"],
        "https://app.example"
    );
    assert!(
        !preflight
            .headers()
            .contains_key("access-control-allow-credentials")
    );
    assert!(!preflight.headers().contains_key("link"));
    assert_eq!(
        native
            .get(format!("{signal_root}/whip"))
            .header("origin", "https://evil.example")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        native
            .get(format!("{signal_root}/whip"))
            .header("host", endpoint.to_string())
            .header("x-forwarded-host", "media.control.test")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let wrong_name = Client::builder()
        .tls_backend_rustls()
        .tls_certs_only([reqwest::Certificate::from_der(fixture.pki.ca.der().as_ref()).unwrap()])
        .resolve("wrong-name.control.test", endpoint)
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    assert!(
        wrong_name
            .get(format!(
                "https://wrong-name.control.test:{}/whip",
                endpoint.port()
            ))
            .send()
            .await
            .is_err()
    );
    assert!(
        local
            .get(format!("http://{endpoint}/whip"))
            .send()
            .await
            .is_err()
    );
    let probe = std::net::UdpSocket::bind(SocketAddr::new(ip, 0)).unwrap();
    let offer = format!(
        "v=0\r\no=- 123 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\na=ice-ufrag:abcdefgh\r\na=ice-pwd:abcdefghijklmnopqrstuvwxyz1234\r\na=fingerprint:sha-256 {}\r\na=setup:actpass\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\na=mid:0\r\na=sendonly\r\na=rtcp-mux\r\na=rtpmap:96 VP8/90000\r\na=candidate:1 1 UDP 2130706431 {ip} {} typ host\r\na=end-of-candidates\r\n",
        vec!["01"; 32].join(":"),
        probe.local_addr().unwrap().port()
    );
    let response = native
        .post(format!("{signal_root}/whip"))
        .bearer_auth(&publisher)
        .header("content-type", "application/sdp")
        .body(offer)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(response.headers().contains_key("link"), relay_requested);
    let resource = response.headers()["location"].to_str().unwrap().to_owned();
    assert!(resource.starts_with(&format!("{signal_root}/whip/sessions/")));
    let answer = response.text().await.unwrap();
    assert!(
        answer.contains(&format!("{ip} {} typ host", udp.port())),
        "{answer}"
    );
    assert_eq!(
        native
            .get(&resource)
            .bearer_auth(&publisher)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        native
            .get(&resource)
            .bearer_auth(&subscriber)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        native
            .delete(&resource)
            .bearer_auth(&publisher)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let mut turn_stats = None;
    let mut turn_process = None;
    if let Some(directory) = &browser_dir {
        assert!(
            directory.is_absolute() && directory.starts_with("O:/"),
            "浏览器证据须位于O盘绝对目录"
        );
        std::fs::create_dir_all(directory).unwrap();
        let pin = STANDARD.encode(Sha256::digest(&server_identity.public_key_der));
        let mut browser_fixture = json!({
            "schema":"https-signal-browser-fixture-v1","url":root,"signaling_root":format!("{signal_root}/"),
            "server_name":"media.control.test","server_ip":ip,"spki_sha256_base64":pin,
            "grants":{"publisher":mint("alice","publisher"),"viewer-1":mint("bob","subscriber"),"viewer-2":mint("carol","subscriber")},
            "binding":binding,"media_endpoint":udp,"assignment_revision":revision
        });
        if relay_requested {
            browser_fixture["rtc_configuration"] = json!({
                "iceTransportPolicy":"relay","iceServers":[]
            });
            browser_fixture["ice_discovery"] = json!(true);
            browser_fixture["turn_relay_ports"] = turn_metadata["ports"].clone();
            browser_fixture["turn_bind"] = turn_metadata["bind"].clone();
            browser_fixture["turn_pid"] = turn_metadata["pid"].clone();
            assert!(
                !serde_json::to_string(&browser_fixture)
                    .unwrap()
                    .contains("\"credential\"")
            );
        }
        std::fs::write(
            directory.join("browser-fixture.json"),
            serde_json::to_vec_pretty(&browser_fixture).unwrap(),
        )
        .unwrap();
        println!(
            "HTTPS信令浏览器夹具：{}",
            directory.join("browser-fixture.json").display()
        );
        tokio::time::timeout(Duration::from_secs(100), async {
            loop {
                if directory.join("browser-result.json").is_file() {
                    break;
                }
                assert!(
                    media.0.try_wait().unwrap().is_none(),
                    "浏览器验证期间媒体提前退出"
                );
                if let Some(turn) = &mut turn {
                    assert!(
                        turn.process.0.try_wait().unwrap().is_none(),
                        "浏览器验证期间独立TURN提前退出"
                    );
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .expect("未收到浏览器实际播放结果");
        let result: Value =
            serde_json::from_slice(&std::fs::read(directory.join("browser-result.json")).unwrap())
                .unwrap();
        assert_eq!(result["schema"], "https-signal-browser-v1");
        assert_eq!(result["signal_origin"], signal_root);
        assert_eq!(result["actual_decoding_verified"], true);
        if let Some(turn) = turn {
            assert_eq!(result["forced_relay_verified"], true);
            for name in ["publisher", "viewer-1", "viewer-2"] {
                assert_eq!(
                    result["result"]["first"]["ice_discovery"][name]["source"],
                    "authenticated-options"
                );
                assert_eq!(
                    result["result"]["first"]["ice_discovery"][name]["configured_before_local_description"],
                    true
                );
            }
            let receipt = turn.stop().await;
            let stats = &receipt["stopped"]["stats"];
            assert!(stats["allocations_created"].as_u64().unwrap() >= 3);
            assert!((3..=8).contains(&stats["peak_allocations"].as_u64().unwrap()));
            for field in [
                "bytes_to_peer",
                "bytes_from_peer",
                "bytes_to_client",
                "bytes_from_client",
            ] {
                assert!(stats[field].as_u64().unwrap() > 0, "{field}");
            }
            assert_eq!(stats["active_allocations"], 0);
            assert_eq!(stats["expired"], false, "TURN不应在播放验证中提前到期");
            for address in turn_addresses {
                assert!(std::net::UdpSocket::bind(address).is_ok());
            }
            turn_stats = Some(stats.clone());
            turn_process = Some(receipt);
        }
        media.0.kill().unwrap();
        media.0.wait().unwrap();
    } else {
        let (status, _) = tokio::time::timeout(Duration::from_secs(40), async {
            let status = loop {
                if let Some(status) = media.0.try_wait().unwrap() {
                    break status;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            };
            (status, ())
        })
        .await
        .expect("媒体监听未按期限自然停机");
        assert!(status.success());
    }
    drop(media);
    assert!(std::net::UdpSocket::bind(udp).is_ok());
    assert!(
        native
            .get(format!("{signal_root}/whip"))
            .send()
            .await
            .is_err()
    );
    println!(
        "HTTPS信令闭环验证：{}",
        json!({
            "schema":"live-signaling-tls-lab-v1","coordination_bind":ip,"signaling_bind":endpoint.ip(),
            "media_bind":udp.ip(),"coordinators":3,"media_processes":1,"physical_hosts":1,
            "client_certificate_required":false,"native_jwt_session_verified":true,
            "private_candidate_verified":true,"admin_and_diagnostics_not_exposed":true,
            "host_origin_and_tls_rejections":true,"process_and_udp_reclaimed":true,
            "browser_mode":browser_dir.is_some(),"graceful_shutdown":browser_dir.is_none(),
            "turn_relay_verified":turn_stats.is_some(),"turn_stats":turn_stats,
            "turn_separate_process":turn_process.is_some(),"turn_process":turn_process,
            "authenticated_ice_discovery_verified":relay_requested
        })
    );
}

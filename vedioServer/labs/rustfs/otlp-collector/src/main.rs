use bytes::Bytes;
use flate2::read::GzDecoder;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::common::v1::{KeyValue, any_value::Value as AnyValue};
use opentelemetry_proto::tonic::metrics::v1::{Metric, NumberDataPoint, metric, number_data_point};
use prost::Message;
use serde::Serialize;
use std::collections::BTreeMap;
use std::convert::Infallible;
use std::env;
use std::fs::{OpenOptions, create_dir_all};
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::sync::Mutex;

const BODY_LIMIT: usize = 4 * 1024 * 1024;
const TARGET_METRICS: &[&str] = &[
    "rustfs_remote_lock_rpc_detached_total",
    "rustfs_remote_lock_rpc_late_completions_total",
    "rustfs_remote_lock_late_releases_total",
    "rustfs_remote_lock_request_suppressed_total",
];

#[derive(Debug)]
struct Config {
    bind: String,
    output: PathBuf,
}

#[derive(Serialize)]
struct ExportRecord {
    schema: &'static str,
    received_unix_ms: u128,
    metrics: Vec<MetricRecord>,
}

#[derive(Serialize)]
struct MetricRecord {
    name: String,
    start_time_unix_nano: u64,
    time_unix_nano: u64,
    points: Vec<PointRecord>,
}

#[derive(Serialize)]
struct PointRecord {
    value: f64,
    attributes: BTreeMap<String, String>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = parse_args()?;
    if let Some(parent) = config.output.parent() {
        create_dir_all(parent)?;
    }
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&config.output)?;
    let file = Arc::new(Mutex::new(tokio::fs::File::from_std(file)));
    let listener = TcpListener::bind(&config.bind).await?;
    println!(
        "{{\"schema\":\"rustfs-otlp-collector-ready-v1\",\"address\":\"{}\",\"output\":\"{}\"}}",
        listener.local_addr()?,
        config.output.display()
    );

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let file = file.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |request| handle_request(request, file.clone()));
                    let _ = http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
            _ = tokio::signal::ctrl_c() => break,
        }
    }
    Ok(())
}

fn parse_args() -> Result<Config, String> {
    let mut bind = None;
    let mut output = None;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--bind" => bind = Some(args.next().ok_or("missing --bind value")?),
            "--output" => {
                output = Some(PathBuf::from(args.next().ok_or("missing --output value")?))
            }
            "--help" => {
                return Err(
                    "usage: rustfs-otlp-collector --bind HOST:PORT --output FILE".to_string(),
                );
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(Config {
        bind: bind.ok_or("--bind is required")?,
        output: output.ok_or("--output is required")?,
    })
}

async fn handle_request(
    request: Request<Incoming>,
    file: Arc<Mutex<tokio::fs::File>>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    if request.method() == hyper::Method::GET && request.uri().path() == "/healthz" {
        return Ok(response(StatusCode::OK));
    }
    if request.uri().path() != "/v1/metrics" {
        return Ok(response(StatusCode::NOT_FOUND));
    }

    let gzip = request
        .headers()
        .get(hyper::header::CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("gzip"));
    let collected = match request.into_body().collect().await {
        Ok(value) => value.to_bytes(),
        Err(_) => return Ok(response(StatusCode::BAD_REQUEST)),
    };
    if collected.len() > BODY_LIMIT {
        return Ok(response(StatusCode::PAYLOAD_TOO_LARGE));
    }
    let payload = match decode_payload(collected, gzip) {
        Ok(value) => value,
        Err(_) => return Ok(response(StatusCode::BAD_REQUEST)),
    };
    let export = match ExportMetricsServiceRequest::decode(payload.as_slice()) {
        Ok(value) => value,
        Err(_) => return Ok(response(StatusCode::BAD_REQUEST)),
    };
    let record = ExportRecord {
        schema: "rustfs-otlp-metric-export-v1",
        received_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default(),
        metrics: collect_target_metrics(&export),
    };
    let mut line = match serde_json::to_vec(&record) {
        Ok(value) => value,
        Err(_) => return Ok(response(StatusCode::INTERNAL_SERVER_ERROR)),
    };
    line.push(b'\n');
    let mut output = file.lock().await;
    if output.write_all(&line).await.is_err() || output.flush().await.is_err() {
        return Ok(response(StatusCode::INTERNAL_SERVER_ERROR));
    }
    Ok(response(StatusCode::OK))
}

fn decode_payload(body: Bytes, gzip: bool) -> Result<Vec<u8>, std::io::Error> {
    if !gzip {
        return Ok(body.to_vec());
    }
    let mut decoder = GzDecoder::new(body.as_ref());
    let mut decoded = Vec::new();
    decoder
        .by_ref()
        .take((BODY_LIMIT + 1) as u64)
        .read_to_end(&mut decoded)?;
    if decoded.len() > BODY_LIMIT {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "decoded body too large",
        ));
    }
    Ok(decoded)
}

fn collect_target_metrics(export: &ExportMetricsServiceRequest) -> Vec<MetricRecord> {
    export
        .resource_metrics
        .iter()
        .flat_map(|resource| resource.scope_metrics.iter())
        .flat_map(|scope| scope.metrics.iter())
        .filter(|metric| TARGET_METRICS.contains(&metric.name.as_str()))
        .filter_map(metric_record)
        .collect()
}

fn metric_record(metric: &Metric) -> Option<MetricRecord> {
    let (start_time_unix_nano, time_unix_nano, points) = match metric.data.as_ref()? {
        metric::Data::Gauge(gauge) => (
            0,
            gauge
                .data_points
                .iter()
                .map(|point| point.time_unix_nano)
                .max()
                .unwrap_or_default(),
            gauge.data_points.iter().filter_map(point_record).collect(),
        ),
        metric::Data::Sum(sum) => (
            sum.data_points
                .iter()
                .map(|point| point.start_time_unix_nano)
                .min()
                .unwrap_or_default(),
            sum.data_points
                .iter()
                .map(|point| point.time_unix_nano)
                .max()
                .unwrap_or_default(),
            sum.data_points.iter().filter_map(point_record).collect(),
        ),
        _ => return None,
    };
    Some(MetricRecord {
        name: metric.name.clone(),
        start_time_unix_nano,
        time_unix_nano,
        points,
    })
}

fn point_record(point: &NumberDataPoint) -> Option<PointRecord> {
    let value = number_point_value(point.value.as_ref())?;
    Some(PointRecord {
        value,
        attributes: point.attributes.iter().filter_map(attribute_pair).collect(),
    })
}

fn number_point_value(value: Option<&number_data_point::Value>) -> Option<f64> {
    match value? {
        number_data_point::Value::AsDouble(value) => Some(*value),
        number_data_point::Value::AsInt(value) => Some(*value as f64),
    }
}

fn attribute_pair(attribute: &KeyValue) -> Option<(String, String)> {
    let value = attribute.value.as_ref()?.value.as_ref()?;
    let value = match value {
        AnyValue::StringValue(value) => value.clone(),
        AnyValue::BoolValue(value) => value.to_string(),
        AnyValue::IntValue(value) => value.to_string(),
        AnyValue::DoubleValue(value) => value.to_string(),
        _ => "<non-scalar>".to_string(),
    };
    Some((attribute.key.clone(), value))
}

fn response(status: StatusCode) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .body(Full::new(Bytes::new()))
        .expect("static HTTP response is valid")
}

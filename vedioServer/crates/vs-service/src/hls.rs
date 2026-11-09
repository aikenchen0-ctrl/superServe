// SPDX-License-Identifier: MIT
// 流程改编自vbasky/sheathe的crates/sheathe-package/src/lib.rs，
// 参考提交540f87cf55bc5243854efce6e8257a89f7ad463d；原版权见LICENSES/sheathe-MIT.txt。
// 仅调用MP4分片和HLS清单内核，新增资源预检、时间线保留与既有内容寻址发布。

use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, Read, Write},
    path::Path,
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use sheathe_core::{Codec, MediaKind};
use sheathe_hls::{MediaPlaylist, SegmentRef, Variant, master_playlist};
use sheathe_mp4::{
    BoxWriter, Cursor, FourCc, Mp4Box, Mp4Demuxer, Segment, SegmentPolicy, Track, fragment,
    top_level, write_init_segment, write_media_segment,
};
use vs_core::{
    catalog::{Candidate, MediaAsset, PublicCatalog},
    valid_id,
};

use crate::publication::{CatalogPublication, publish_catalog, publish_media_file};

const PLAYLIST: &str = "application/vnd.apple.mpegurl";
const MAX_INPUT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_SAMPLES: u64 = 25_000;
const MAX_SEGMENTS: usize = 512;
const MAX_CHUNKS_PER_SEGMENT: usize = 128;
const MAX_CHUNKS_PER_TRACK: u32 = 4096;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum HlsLayout {
    #[default]
    Single,
    Chunked {
        target_ms: u16,
    },
}

impl HlsLayout {
    fn validate(self) -> io::Result<()> {
        match self {
            Self::Single => Ok(()),
            Self::Chunked { target_ms } if (100..=1000).contains(&target_ms) => Ok(()),
            _ => Err(invalid("片内目标时长必须为100至1000毫秒")),
        }
    }
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn parse<T>(result: sheathe_core::Result<T>) -> io::Result<T> {
    result.map_err(|_| invalid("MP4容器或采样表不受支持"))
}

#[derive(Debug, Serialize)]
pub struct HlsSegment {
    pub sha256: String,
    pub bytes: u64,
    pub start_ticks: u64,
    pub duration_ticks: u64,
    pub chunk_count: usize,
}

#[derive(Debug, Serialize)]
pub struct HlsTrack {
    pub track_id: u32,
    pub kind: &'static str,
    pub timescale: u32,
    pub sample_count: usize,
    pub coded_samples_sha256: String,
    pub playlist_sha256: String,
    pub init_sha256: String,
    pub segments: Vec<HlsSegment>,
}

#[derive(Debug, Serialize)]
pub struct HlsPublication {
    pub schema: &'static str,
    pub source_bytes: u64,
    pub target_seconds: u32,
    pub layout: HlsLayout,
    pub master_sha256: String,
    pub media_path: String,
    pub tracks: Vec<HlsTrack>,
    pub catalog: CatalogPublication,
}

fn child<'a>(parent: Mp4Box<'a>, kind: &[u8; 4]) -> io::Result<Mp4Box<'a>> {
    parse(parent.child(kind))?.ok_or_else(|| invalid("MP4缺少必要盒子"))
}

fn children(data: &[u8]) -> io::Result<Vec<Mp4Box<'_>>> {
    let values: Vec<_> = top_level(data)
        .take(4097)
        .map(parse)
        .collect::<io::Result<_>>()?;
    if values.len() > 4096 {
        return Err(invalid("MP4同级盒子数量超过预算"));
    }
    Ok(values)
}

/// 在上游按声明数量分配数组之前校验采样表；不在适配层重写样本解析器。
fn check_tables(trak: Mp4Box<'_>) -> io::Result<u64> {
    let stbl = child(child(child(trak, b"mdia")?, b"minf")?, b"stbl")?;
    let stsz = child(stbl, b"stsz")?;
    let mut c = Cursor::new(stsz.body);
    parse(c.version_flags())?;
    let uniform = parse(c.u32())?;
    let samples = u64::from(parse(c.u32())?);
    if !(1..=MAX_SAMPLES).contains(&samples)
        || (uniform == 0 && c.remaining() as u64 != samples * 4)
        || (uniform != 0 && c.remaining() != 0)
    {
        return Err(invalid("MP4采样数量或表长度超过预算"));
    }
    // 仅限制样本数不够：重复的块偏移可令小文件复制出大量重复载荷。
    let coded_bytes = if uniform == 0 {
        let mut total = 0_u64;
        for _ in 0..samples {
            total += u64::from(parse(c.u32())?);
        }
        total
    } else {
        u64::from(uniform) * samples
    };
    let mut c = Cursor::new(child(stbl, b"stsd")?.body);
    parse(c.version_flags())?;
    if parse(c.u32())? != 1 {
        return Err(invalid("当前仅接受单一采样描述"));
    }
    for value in children(stbl.body)? {
        let width = match &value.kind {
            b"stts" | b"ctts" | b"co64" => 8,
            b"stsc" => 12,
            b"stco" | b"stss" => 4,
            _ => continue,
        };
        let mut c = Cursor::new(value.body);
        let version = parse(c.version_flags())?;
        let entries = u64::from(parse(c.u32())?);
        if entries > MAX_SAMPLES || c.remaining() as u64 != entries * width {
            return Err(invalid("MP4采样表声明与实际字节不符"));
        }
        if matches!(&value.kind, b"stts" | b"ctts") {
            if version != 0 {
                return Err(invalid("当前不接受带符号合成偏移表"));
            }
            let mut total = 0_u64;
            for _ in 0..entries {
                total += u64::from(parse(c.u32())?);
                let delta = parse(c.u32())?;
                if (&value.kind == b"stts" && delta == 0) || total > samples {
                    return Err(invalid("MP4采样时间表无效"));
                }
            }
            if total != samples {
                return Err(invalid("MP4采样时间表不完整"));
            }
        }
    }
    if let Some(edts) = parse(trak.child(b"edts"))? {
        let mut c = Cursor::new(child(edts, b"elst")?.body);
        let version = parse(c.version_flags())?;
        if version > 1 || parse(c.u32())? != 1 {
            return Err(invalid("当前仅接受单段连续编辑列表"));
        }
        let media_time = if version == 1 {
            parse(c.u64())?;
            parse(c.u64())? as i64
        } else {
            parse(c.u32())?;
            i64::from(parse(c.u32())? as i32)
        };
        if media_time < 0 || parse(c.u16())? != 1 || parse(c.u16())? != 0 || c.remaining() != 0 {
            return Err(invalid("当前不接受空编辑或非正常播放速率"));
        }
    }
    Ok(coded_bytes)
}

fn emit(writer: &mut BoxWriter, value: Mp4Box<'_>) {
    writer.begin(FourCc(value.kind));
    writer.bytes(value.body);
    writer.end();
}

fn emit_zero_duration(writer: &mut BoxWriter, value: Mp4Box<'_>) -> io::Result<()> {
    let version = *value.body.first().ok_or_else(|| invalid("MP4时间头截断"))?;
    let (offset, width) = match (&value.kind, version) {
        (b"mvhd", 0) => (16, 4),
        (b"mvhd", 1) => (24, 8),
        (b"tkhd", 0) => (20, 4),
        (b"tkhd", 1) => (28, 8),
        _ => return Err(invalid("MP4时间头版本不受支持")),
    };
    let mut body = value.body.to_vec();
    body.get_mut(offset..offset + width)
        .ok_or_else(|| invalid("MP4时间头长度无效"))?
        .fill(0);
    writer.begin(FourCc(value.kind));
    writer.bytes(&body);
    writer.end();
    Ok(())
}

/// 保留原电影时基、轨道矩阵和编辑列表，避免重封装改变B帧或AAC时间线。
fn init_segment(track: &Track, movie: Mp4Box<'_>, original: Mp4Box<'_>) -> io::Result<Vec<u8>> {
    let generated = write_init_segment(track, None);
    let mut writer = BoxWriter::new();
    for value in children(&generated)? {
        if &value.kind != b"moov" {
            emit(&mut writer, value);
            continue;
        }
        writer.begin(FourCc(*b"moov"));
        for part in children(value.body)? {
            match &part.kind {
                b"mvhd" => emit_zero_duration(&mut writer, child(movie, b"mvhd")?)?,
                b"trak" => {
                    writer.begin(FourCc(*b"trak"));
                    for field in children(part.body)? {
                        if &field.kind == b"tkhd" {
                            emit_zero_duration(&mut writer, child(original, b"tkhd")?)?;
                            if let Some(edts) = parse(original.child(b"edts"))? {
                                emit(&mut writer, edts);
                            }
                        } else {
                            emit(&mut writer, field);
                        }
                    }
                    writer.end();
                }
                _ => emit(&mut writer, part),
            }
        }
        writer.end();
    }
    Ok(writer.into_bytes())
}

fn publish_bytes(
    root: &Path,
    staging: &Path,
    bytes: &[u8],
    content_type: &str,
    assets: &mut Vec<MediaAsset>,
) -> io::Result<MediaAsset> {
    let asset = MediaAsset {
        sha256: format!("{:x}", Sha256::digest(bytes)),
        bytes: bytes.len() as u64,
        content_type: content_type.into(),
    };
    let path = staging.join(&asset.sha256);
    if !assets.iter().any(|value| value.sha256 == asset.sha256) {
        let mut file = File::create_new(&path)?;
        file.write_all(bytes)?;
        drop(file);
        publish_media_file(root, &path, &asset)?;
        assets.push(asset.clone());
        fs::remove_file(path)?;
    }
    Ok(asset)
}

/// 离线有界实验入口；H264视频和可选AAC音轨，单个源文件，不执行转码或并行分片。
pub fn publish_hls(
    root: &Path,
    source: &Path,
    version: &str,
    candidate_id: &str,
    target_seconds: u32,
) -> io::Result<HlsPublication> {
    publish_hls_with_layout(
        root,
        source,
        version,
        candidate_id,
        target_seconds,
        HlsLayout::Single,
    )
}

/// 片内切分只改变封装，清单分片仍从原随机访问点开始，不承诺每个内部片段可独立寻址。
pub fn publish_hls_with_layout(
    root: &Path,
    source: &Path,
    version: &str,
    candidate_id: &str,
    target_seconds: u32,
    layout: HlsLayout,
) -> io::Result<HlsPublication> {
    layout.validate()?;
    if !valid_id(version) || !valid_id(candidate_id) || !(1..=6).contains(&target_seconds) {
        return Err(invalid("HLS发布标识或目标分片时长无效"));
    }
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_INPUT_BYTES
    {
        return Err(invalid("HLS输入必须是已封存普通MP4，最多32MiB"));
    }
    let mut bytes = Vec::new();
    File::open(source)?
        .take(MAX_INPUT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 != metadata.len() {
        return Err(invalid("HLS输入长度发生变化"));
    }
    let boxes = children(&bytes)?;
    if boxes.len() > 4096
        || boxes.iter().any(|value| &value.kind == b"moof")
        || boxes.iter().filter(|value| &value.kind == b"moov").count() != 1
    {
        return Err(invalid("HLS输入顶层布局不受支持"));
    }
    let movie = *boxes.iter().find(|value| &value.kind == b"moov").unwrap();
    let original_tracks: Vec<_> = children(movie.body)?
        .into_iter()
        .filter(|value| &value.kind == b"trak")
        .collect();
    if !(1..=2).contains(&original_tracks.len()) {
        return Err(invalid("HLS输入只能包含一条视频及可选一条音轨"));
    }
    let mut coded_bytes = 0_u64;
    for &original in &original_tracks {
        coded_bytes += check_tables(original)?;
    }
    if coded_bytes > bytes.len() as u64 {
        return Err(invalid("MP4声明媒体总量超过输入载荷预算"));
    }
    let demux = parse(Mp4Demuxer::parse(&bytes))?;
    let tracks = demux.tracks();
    let mut ids = HashSet::new();
    if tracks.len() != original_tracks.len()
        || tracks
            .iter()
            .filter(|track| track.info.kind == MediaKind::Video)
            .count()
            != 1
        || tracks.iter().any(|track| {
            track.track_id == 0
                || track.track_id == u32::MAX
                || !ids.insert(track.track_id)
                || !matches!(
                    (&track.info.kind, &track.info.codec),
                    (MediaKind::Video, Codec::H264) | (MediaKind::Audio, Codec::Aac)
                )
        })
    {
        return Err(invalid("HLS仅接受H264视频与可选AAC音轨"));
    }
    let staging = tempfile::tempdir_in(root)?;
    let mut assets = Vec::new();
    let mut variants = Vec::new();
    let mut receipts = Vec::new();
    for (index, track) in tracks.iter().enumerate() {
        let samples = parse(demux.samples(index))?;
        if samples.is_empty()
            || samples
                .iter()
                .any(|value| value.duration == 0 || value.data.is_empty())
            || !samples[0].is_segment_boundary()
        {
            return Err(invalid("HLS采样必须非空、有时长且从随机访问点开始"));
        }
        let mut hash = Sha256::new();
        for sample in &samples {
            hash.update(&sample.data);
        }
        let sample_count = samples.len();
        let segments = parse(fragment(
            &track.info,
            samples,
            SegmentPolicy {
                target_seconds: f64::from(target_seconds),
                keyframes_only: true,
            },
        ))?;
        if segments.len() > MAX_SEGMENTS {
            return Err(invalid("HLS分片数量超过预算"));
        }
        let init = init_segment(track, movie, original_tracks[index])?;
        let content_type = if track.info.kind == MediaKind::Video {
            "video/mp4"
        } else {
            "audio/mp4"
        };
        let init_asset = publish_bytes(root, staging.path(), &init, content_type, &mut assets)?;
        let mut segment_refs = Vec::new();
        let mut segment_receipts = Vec::new();
        let mut peak = 0_u64;
        let mut next_sequence = 1_u32;
        for segment in segments {
            let start_ticks = segment.start_ticks;
            let duration_ticks = segment.duration_ticks;
            let duration = duration_ticks as f64 / f64::from(track.info.timescale.0);
            if !duration.is_finite() || !(0.0..=30.0).contains(&duration) || duration == 0.0 {
                return Err(invalid("HLS实际分片时长越界；源关键帧过于稀疏"));
            }
            let (data, chunk_count) = encode_segment(track, segment, layout, &mut next_sequence)?;
            peak = peak.max(
                (data.len() as u64 * 8 * u64::from(track.info.timescale.0))
                    .div_ceil(duration_ticks),
            );
            let asset = publish_bytes(root, staging.path(), &data, content_type, &mut assets)?;
            segment_refs.push(SegmentRef::new(
                duration,
                format!("/v1/media/{}/media.mp4", asset.sha256),
            ));
            segment_receipts.push(HlsSegment {
                sha256: asset.sha256,
                bytes: asset.bytes,
                start_ticks,
                duration_ticks,
                chunk_count,
            });
        }
        let playlist = MediaPlaylist::vod(
            format!("/v1/media/{}/media.mp4", init_asset.sha256),
            segment_refs,
            None,
        )
        .to_m3u8();
        let playlist_asset = publish_bytes(
            root,
            staging.path(),
            playlist.as_bytes(),
            PLAYLIST,
            &mut assets,
        )?;
        let mut variant = Variant::new(
            track.info.clone(),
            format!("/v1/media/{}/index.m3u8", playlist_asset.sha256),
        );
        variant.bandwidth = Some(
            u32::try_from(peak)
                .ok()
                .filter(|value| *value < u32::MAX / 2)
                .ok_or_else(|| invalid("HLS峰值码率超出清单表示范围"))?,
        );
        variants.push(variant);
        receipts.push(HlsTrack {
            track_id: track.track_id,
            kind: if track.info.kind == MediaKind::Video {
                "video"
            } else {
                "audio"
            },
            timescale: track.info.timescale.0,
            sample_count,
            coded_samples_sha256: format!("{:x}", hash.finalize()),
            playlist_sha256: playlist_asset.sha256,
            init_sha256: init_asset.sha256,
            segments: segment_receipts,
        });
    }
    let master = master_playlist(&variants);
    let master_asset = publish_bytes(
        root,
        staging.path(),
        master.as_bytes(),
        PLAYLIST,
        &mut assets,
    )?;
    let catalog = PublicCatalog {
        version: version.into(),
        items: vec![Candidate {
            id: candidate_id.into(),
            domain: "video".into(),
            tags: Vec::new(),
            prior: 0.5,
            media_sha256: Some(master_asset.sha256.clone()),
        }],
        assets,
    };
    let publication = publish_catalog(
        root,
        &serde_json::to_vec(&catalog).map_err(io::Error::other)?,
    )?;
    Ok(HlsPublication {
        schema: "hls-publication-v1",
        source_bytes: bytes.len() as u64,
        target_seconds,
        layout,
        media_path: format!("/v1/media/{}/index.m3u8", master_asset.sha256),
        master_sha256: master_asset.sha256,
        tracks: receipts,
        catalog: publication,
    })
}

fn encode_segment(
    track: &Track,
    segment: Segment,
    layout: HlsLayout,
    next_sequence: &mut u32,
) -> io::Result<(Vec<u8>, usize)> {
    let chunks = match layout {
        HlsLayout::Single => vec![segment],
        HlsLayout::Chunked { target_ms } => parse(fragment(
            &track.info,
            segment.samples,
            SegmentPolicy {
                target_seconds: f64::from(target_ms) / 1000.0,
                keyframes_only: false,
            },
        ))?,
    };
    if chunks.is_empty()
        || chunks.len() > MAX_CHUNKS_PER_SEGMENT
        || next_sequence.saturating_add(chunks.len() as u32) > MAX_CHUNKS_PER_TRACK + 1
    {
        return Err(invalid("HLS片内数量超过有界预算"));
    }
    let count = chunks.len();
    let mut output = BoxWriter::new();
    for (index, chunk) in chunks.into_iter().enumerate() {
        let encoded = write_media_segment(track, *next_sequence, &chunk, 0, None);
        *next_sequence += 1;
        if layout == HlsLayout::Single {
            return Ok((encoded, 1));
        }
        // 上游sidx固定声明SAP；内部非关键帧切点不能沿用该声明。
        // 保留首个styp及各自的moof相对偏移，避免重写样本表与编码载荷。
        for value in children(&encoded)? {
            if matches!(&value.kind, b"moof" | b"mdat") || (&value.kind == b"styp" && index == 0) {
                emit(&mut output, value);
            }
        }
    }
    Ok((output.into_bytes(), count))
}

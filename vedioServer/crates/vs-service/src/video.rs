// SPDX-License-Identifier: MIT
// 输出流程改编自privacyresearchgroup/mp4san的cli/src/main.rs，
// 参考提交ccc2bec881a730981886b144a9660b303126c6f3，原版权见LICENSES/mp4san-MIT.txt。
// 新增头部资源预检、完整复制、流式散列及不可覆盖输出；容器重定位由锁定依赖完成。

use std::{
    fs::{self, File},
    io::{self, BufWriter, Read, Seek, SeekFrom, Write},
    path::Path,
};

use mp4san::parse::{BoxHeader, BoxType};
use serde::Serialize;
use sha2::{Digest, Sha256};
use vs_core::catalog::MediaAsset;

use crate::upstream::atomic_create::atomic_create;

const MIB: u64 = 1024 * 1024;
const COPY_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug)]
pub struct Mp4Limits {
    pub max_input_bytes: u64,
    pub max_metadata_bytes: u64,
    pub max_top_level_boxes: usize,
}

impl Default for Mp4Limits {
    fn default() -> Self {
        Self {
            max_input_bytes: 512 * MIB,
            max_metadata_bytes: 8 * MIB,
            max_top_level_boxes: 4096,
        }
    }
}

impl Mp4Limits {
    fn validate(self) -> io::Result<()> {
        if !(1..=8 * 1024 * MIB).contains(&self.max_input_bytes)
            || !(1..=64 * MIB).contains(&self.max_metadata_bytes)
            || !(1..=65_536).contains(&self.max_top_level_boxes)
        {
            return Err(io::Error::other("MP4处理资源预算无效"));
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
pub struct PreparedMp4 {
    pub schema: &'static str,
    pub source_bytes: u64,
    pub asset: MediaAsset,
    pub repacked: bool,
    pub input_media_offset: u64,
    pub output_media_offset: u64,
    pub media_span_bytes: u64,
}

/// 只检查顶层布局和资源范围；盒子头及内部索引仍交给上游解析。
fn preflight(file: &mut File, bytes: u64, limits: Mp4Limits) -> io::Result<()> {
    let mut offset = 0_u64;
    let mut metadata = 0_u64;
    let mut boxes = 0;
    let mut movies = 0;
    while offset < bytes {
        boxes += 1;
        if boxes > limits.max_top_level_boxes {
            return Err(io::Error::other("MP4顶层盒子数量超过预算"));
        }
        let mut buffer = [0_u8; BoxHeader::MAX_SIZE as usize];
        let length = (bytes - offset).min(buffer.len() as u64) as usize;
        file.seek(SeekFrom::Start(offset))?;
        file.read_exact(&mut buffer[..length])?;
        let header = BoxHeader::parse(&buffer[..length])
            .map_err(|_| io::Error::other("MP4盒子头无效或截断"))?;
        header
            .box_data_size()
            .map_err(|_| io::Error::other("MP4盒子长度无效"))?;
        let size = header.box_size().unwrap_or(bytes - offset);
        let end = offset
            .checked_add(size)
            .filter(|end| *end <= bytes && *end > offset)
            .ok_or_else(|| io::Error::other("MP4盒子超出实际输入范围"))?;
        if header.box_type() != BoxType::MDAT {
            // 同时限制free等填充，避免上游为保留数据偏移分配巨大的前缀。
            metadata = metadata
                .checked_add(size)
                .filter(|size| *size <= limits.max_metadata_bytes)
                .ok_or_else(|| io::Error::other("MP4非媒体内容超过元数据预算"))?;
        }
        if header.box_type() == BoxType::MOOV {
            movies += 1;
            if movies > 1 {
                return Err(io::Error::other("MP4不能包含重复的播放索引"));
            }
        }
        offset = end;
    }
    file.rewind()
}

fn copy_exact(
    source: &mut File,
    output: &mut BufWriter<&mut File>,
    length: u64,
    hash: &mut Sha256,
) -> io::Result<()> {
    let mut remaining = length;
    let mut buffer = [0_u8; COPY_BYTES];
    while remaining != 0 {
        let next = remaining.min(buffer.len() as u64) as usize;
        let read = source.read(&mut buffer[..next])?;
        if read == 0 {
            return Err(io::Error::other("MP4媒体数据未完整复制，未发布"));
        }
        output.write_all(&buffer[..read])?;
        hash.update(&buffer[..read]);
        remaining -= read as u64;
    }
    Ok(())
}

/// 阻塞处理已封存的普通输入文件；输出保留原编码，不能据此判断设备兼容或解码正确性。
pub fn prepare_mp4(source: &Path, output: &Path, limits: Mp4Limits) -> io::Result<PreparedMp4> {
    limits.validate()?;
    let metadata = fs::symlink_metadata(source)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(io::Error::other("MP4输入必须是普通文件，不能是链接"));
    }
    let mut input = File::open(source)?;
    let source_bytes = input.metadata()?.len();
    if source_bytes == 0 || source_bytes > limits.max_input_bytes {
        return Err(io::Error::other("MP4输入为空或超过文件预算"));
    }
    preflight(&mut input, source_bytes, limits)?;
    let sanitized = mp4san::sanitize_with_config(
        &mut input,
        mp4san::Config {
            max_metadata_size: limits.max_metadata_bytes,
            cumulative_mdat_box_size: None,
        },
    )
    .map_err(|_| io::Error::other("MP4格式不支持或索引无效；本入口不接受分片MP4"))?;
    let data = sanitized.data;
    data.offset
        .checked_add(data.len)
        .filter(|end| *end <= source_bytes && data.len > 8)
        .ok_or_else(|| io::Error::other("MP4媒体范围为空或越界"))?;
    let repacked = sanitized.metadata.is_some();
    let output_media_offset = sanitized
        .metadata
        .as_ref()
        .map_or(data.offset, |value| value.len() as u64);
    if output_media_offset > limits.max_metadata_bytes {
        return Err(io::Error::other("MP4输出前缀超过元数据预算"));
    }
    let output_bytes = if repacked {
        output_media_offset + data.len
    } else {
        source_bytes
    };
    if output_bytes > limits.max_input_bytes {
        return Err(io::Error::other("MP4输出超过文件预算"));
    }
    let mut hash = Sha256::new();
    atomic_create(output, |writer| {
        if let Some(metadata) = &sanitized.metadata {
            writer.write_all(metadata)?;
            hash.update(metadata);
            input.seek(SeekFrom::Start(data.offset))?;
            copy_exact(&mut input, writer, data.len, &mut hash)?;
        } else {
            input.rewind()?;
            copy_exact(&mut input, writer, source_bytes, &mut hash)?;
        }
        if input.metadata()?.len() != source_bytes {
            return Err(io::Error::other("MP4输入长度在处理期间发生变化"));
        }
        Ok(())
    })?;
    Ok(PreparedMp4 {
        schema: "prepared-mp4-v1",
        source_bytes,
        asset: MediaAsset {
            sha256: format!("{:x}", hash.finalize()),
            bytes: output_bytes,
            content_type: "video/mp4".into(),
        },
        repacked,
        input_media_offset: data.offset,
        output_media_offset,
        media_span_bytes: data.len,
    })
}

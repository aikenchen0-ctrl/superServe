use std::{env, io, path::Path};

use serde_json::json;
use vs_core::{
    catalog::{Candidate, PublicCatalog},
    valid_id,
};
use vs_service::{
    publication::{publish_catalog, publish_media_file},
    video::{Mp4Limits, prepare_mp4},
};

fn run() -> io::Result<()> {
    let arguments: Vec<_> = env::args_os().skip(1).collect();
    if arguments.len() != 4 {
        return Err(io::Error::other(
            "用法：publish_video <已存在发布根目录> <源MP4> <新目录版本> <候选标识>",
        ));
    }
    let version = arguments[2]
        .to_str()
        .filter(|value| valid_id(value))
        .ok_or_else(|| io::Error::other("目录版本无效"))?;
    let id = arguments[3]
        .to_str()
        .filter(|value| valid_id(value))
        .ok_or_else(|| io::Error::other("候选标识无效"))?;
    let root = Path::new(&arguments[0]).canonicalize()?;
    // 每次独立暂存；错误返回时自动清理，已提交对象可能保留为未引用内容。
    let staging = tempfile::tempdir_in(&root)?;
    let prepared_path = staging.path().join("prepared.mp4");
    let prepared = prepare_mp4(
        Path::new(&arguments[1]),
        &prepared_path,
        Mp4Limits::default(),
    )?;
    let catalog = PublicCatalog {
        version: version.into(),
        items: vec![Candidate {
            id: id.into(),
            domain: "video".into(),
            tags: Vec::new(),
            prior: 0.5,
            media_sha256: Some(prepared.asset.sha256.clone()),
        }],
        assets: vec![prepared.asset.clone()],
    };
    let media = publish_media_file(&root, &prepared_path, &prepared.asset)?;
    let release = publish_catalog(
        &root,
        &serde_json::to_vec(&catalog).map_err(io::Error::other)?,
    )?;
    serde_json::to_writer_pretty(
        io::stdout(),
        &json!({
            "schema": "video-publication-v1",
            "prepared": prepared,
            "media": media,
            "catalog": release,
            "media_path": format!("/v1/media/{}", catalog.assets[0].sha256),
        }),
    )
    .map_err(io::Error::other)?;
    println!();
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("视频发布失败：{error}");
        std::process::exit(1);
    }
}

use std::{
    fs::{self, File},
    io::{self, BufWriter, Read, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use vs_core::{
    catalog::{MediaAsset, PublicCatalog},
    valid_id,
};

use crate::upstream::atomic_create::atomic_create;

pub(crate) const MAX_CATALOG_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_RELEASE_BYTES: usize = 4096;
const RELEASE_SCHEMA: &str = "catalog-release-v1";
const COPY_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Debug, Serialize)]
pub struct AssetPublication {
    pub schema: &'static str,
    pub object_key: String,
    pub sha256: String,
    pub bytes: u64,
    pub created: bool,
    pub verified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogRelease {
    pub schema: String,
    pub version: String,
    pub catalog_sha256: String,
    pub catalog_bytes: usize,
    pub asset_count: usize,
    pub asset_bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct CatalogPublication {
    pub schema: &'static str,
    pub release: CatalogRelease,
    pub catalog_created: bool,
    pub release_created: bool,
    pub assets_verified: usize,
}

fn root_path(root: &Path) -> io::Result<PathBuf> {
    let root = root.canonicalize()?;
    if !root.is_dir() {
        return Err(io::Error::other("发布根目录必须是已存在的目录"));
    }
    Ok(root)
}

fn directory(root: &Path, name: &str) -> io::Result<PathBuf> {
    let target = root.join(name);
    match fs::create_dir(&target) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let metadata = fs::symlink_metadata(&target)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::other("发布子目录必须是普通目录，不能是链接"));
    }
    Ok(target)
}

fn regular_file(path: &Path) -> io::Result<File> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(io::Error::other("发布输入及对象必须是普通文件"));
    }
    File::open(path)
}

fn fingerprint(reader: &mut impl Read, expected_bytes: u64) -> io::Result<String> {
    let mut hasher = Sha256::new();
    let mut read = 0_u64;
    let mut buffer = [0_u8; COPY_BUFFER_BYTES];
    loop {
        let length = reader.read(&mut buffer)?;
        if length == 0 {
            break;
        }
        read = read
            .checked_add(length as u64)
            .filter(|length| *length <= expected_bytes)
            .ok_or_else(|| io::Error::other("对象超过目录声明的长度"))?;
        hasher.update(&buffer[..length]);
    }
    if read != expected_bytes {
        return Err(io::Error::other("对象长度与目录声明不符"));
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn verify_asset(path: &Path, asset: &MediaAsset) -> io::Result<()> {
    let mut source = regular_file(path)?;
    if source.metadata()?.len() != asset.bytes
        || fingerprint(&mut source, asset.bytes)? != asset.sha256
    {
        return Err(io::Error::other("已发布对象的长度或散列不符，拒绝覆盖修复"));
    }
    Ok(())
}

fn copy_verified(
    source: &mut impl Read,
    target: &mut BufWriter<&mut File>,
    asset: &MediaAsset,
) -> io::Result<()> {
    let mut read = 0_u64;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; COPY_BUFFER_BYTES];
    loop {
        let length = source.read(&mut buffer)?;
        if length == 0 {
            break;
        }
        read = read
            .checked_add(length as u64)
            .filter(|length| *length <= asset.bytes)
            .ok_or_else(|| io::Error::other("媒体输入超过声明长度，未发布"))?;
        hash.update(&buffer[..length]);
        target.write_all(&buffer[..length])?;
    }
    if read != asset.bytes || format!("{:x}", hash.finalize()) != asset.sha256 {
        return Err(io::Error::other("媒体输入长度或散列不符，未发布"));
    }
    Ok(())
}

/// 离线阻塞发布；现有对象完整校验后复用，禁止按相同内容键覆盖。
pub fn publish_media_file(
    root: &Path,
    source: &Path,
    asset: &MediaAsset,
) -> io::Result<AssetPublication> {
    asset
        .validate()
        .map_err(|_| io::Error::other("媒体资产声明无效"))?;
    let root = root_path(root)?;
    let target = directory(&root, "media")?.join(&asset.sha256);
    let created = match fs::symlink_metadata(&target) {
        Ok(_) => {
            verify_asset(&target, asset)?;
            false
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let mut input = regular_file(source)?;
            if input.metadata()?.len() != asset.bytes {
                return Err(io::Error::other("媒体输入长度与声明不符"));
            }
            match atomic_create(&target, |output| copy_verified(&mut input, output, asset)) {
                Ok(()) => true,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    // 并发赢家只能留下相同完整内容；损坏对象不自动覆盖。
                    verify_asset(&target, asset)?;
                    false
                }
                Err(error) => return Err(error),
            }
        }
        Err(error) => return Err(error),
    };
    Ok(AssetPublication {
        schema: "media-publication-v1",
        object_key: asset.object_key(),
        sha256: asset.sha256.clone(),
        bytes: asset.bytes,
        created,
        verified: true,
    })
}

pub(crate) fn catalog(bytes: &[u8]) -> io::Result<PublicCatalog> {
    if bytes.len() > MAX_CATALOG_BYTES {
        return Err(io::Error::other("目录超过8MiB"));
    }
    let catalog: PublicCatalog =
        serde_json::from_slice(bytes).map_err(|_| io::Error::other("目录JSON无效"))?;
    catalog
        .validate()
        .map_err(|_| io::Error::other("目录声明校验失败"))?;
    Ok(catalog)
}

fn read_limited(path: &Path, maximum: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    regular_file(path)?
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > maximum {
        return Err(io::Error::other("发布文件超过读取上限"));
    }
    Ok(bytes)
}

fn create_exact(path: &Path, bytes: &[u8], limit: usize) -> io::Result<bool> {
    match atomic_create(path, |writer| writer.write_all(bytes)) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            if read_limited(path, limit)? == bytes {
                Ok(false)
            } else {
                Err(io::Error::other("发布标识已绑定其他内容，拒绝覆盖"))
            }
        }
        Err(error) => Err(error),
    }
}

/// 资产完整校验后先发布目录，最后发布版本记录；版本一旦占用不可重新绑定。
pub fn publish_catalog(root: &Path, bytes: &[u8]) -> io::Result<CatalogPublication> {
    let catalog = catalog(bytes)?;
    let root = root_path(root)?;
    let media = directory(&root, "media")?;
    let catalogs = directory(&root, "catalogs")?;
    let releases = directory(&root, "releases")?;
    for asset in &catalog.assets {
        verify_asset(&media.join(&asset.sha256), asset)?;
    }
    let release = catalog_release(&catalog, bytes);
    let release_bytes = serde_json::to_vec(&release).map_err(io::Error::other)?;
    let catalog_created = create_exact(
        &catalogs.join(format!("{}.json", release.catalog_sha256)),
        bytes,
        MAX_CATALOG_BYTES,
    )?;
    let release_created = create_exact(
        &releases.join(format!("{}.json", release.version)),
        &release_bytes,
        MAX_RELEASE_BYTES,
    )?;
    Ok(CatalogPublication {
        schema: "catalog-publication-v1",
        assets_verified: release.asset_count,
        release,
        catalog_created,
        release_created,
    })
}

/// 加载固定版本及内容指纹；媒体完整性已在发布阶段验证，运行实例不追随可变latest。
pub fn load_catalog_release(root: &Path, version: &str) -> io::Result<Vec<u8>> {
    if !valid_id(version) {
        return Err(io::Error::other("发布版本标识无效"));
    }
    let root = root_path(root)?;
    let releases = root.join("releases");
    let release = decode_release(
        &read_limited(&releases.join(format!("{version}.json")), MAX_RELEASE_BYTES)?,
        version,
    )?;
    let bytes = read_limited(
        &root
            .join("catalogs")
            .join(format!("{}.json", release.catalog_sha256)),
        MAX_CATALOG_BYTES,
    )?;
    verify_catalog_release(&release, &bytes)?;
    Ok(bytes)
}

pub(crate) fn catalog_release(catalog: &PublicCatalog, bytes: &[u8]) -> CatalogRelease {
    CatalogRelease {
        schema: RELEASE_SCHEMA.to_string(),
        version: catalog.version.clone(),
        catalog_sha256: format!("{:x}", Sha256::digest(bytes)),
        catalog_bytes: bytes.len(),
        asset_count: catalog.assets.len(),
        asset_bytes: catalog.assets.iter().map(|asset| asset.bytes).sum(),
    }
}

pub(crate) fn decode_release(bytes: &[u8], version: &str) -> io::Result<CatalogRelease> {
    if !valid_id(version) || bytes.len() > MAX_RELEASE_BYTES {
        return Err(io::Error::other("发布版本或记录长度无效"));
    }
    let release: CatalogRelease =
        serde_json::from_slice(bytes).map_err(|_| io::Error::other("目录发布记录无效"))?;
    if release.schema != RELEASE_SCHEMA
        || release.version != version
        || release.catalog_bytes > MAX_CATALOG_BYTES
        || release.catalog_sha256.len() != 64
        || !release
            .catalog_sha256
            .bytes()
            .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
    {
        return Err(io::Error::other("目录发布记录的版本或指纹无效"));
    }
    Ok(release)
}

pub(crate) fn verify_catalog_release(release: &CatalogRelease, bytes: &[u8]) -> io::Result<()> {
    let catalog = catalog(bytes)?;
    if bytes.len() != release.catalog_bytes
        || format!("{:x}", Sha256::digest(bytes)) != release.catalog_sha256
        || catalog.version != release.version
        || catalog.assets.len() != release.asset_count
        || catalog.assets.iter().map(|asset| asset.bytes).sum::<u64>() != release.asset_bytes
    {
        return Err(io::Error::other("目录与发布记录不一致，拒绝启动"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        io::Cursor,
        sync::{Arc, Barrier},
    };

    use super::*;

    struct GatedReader {
        inner: Cursor<Vec<u8>>,
        reads: usize,
        reached: Arc<Barrier>,
        resume: Arc<Barrier>,
    }

    impl Read for GatedReader {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            if self.reads == 1 {
                self.reached.wait();
                self.resume.wait();
            }
            self.reads += 1;
            self.inner.read(bytes)
        }
    }

    #[test]
    fn final_object_is_invisible_until_complete_content_has_been_verified() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("object");
        let data = vec![7_u8; COPY_BUFFER_BYTES * 2 + 13];
        let asset = MediaAsset {
            sha256: format!("{:x}", Sha256::digest(&data)),
            bytes: data.len() as u64,
            content_type: "application/octet-stream".into(),
        };
        let reached = Arc::new(Barrier::new(2));
        let resume = Arc::new(Barrier::new(2));
        std::thread::scope(|scope| {
            let mut source = GatedReader {
                inner: Cursor::new(data.clone()),
                reads: 0,
                reached: reached.clone(),
                resume: resume.clone(),
            };
            let target_ref = &target;
            let worker = scope.spawn(move || {
                atomic_create(target_ref, |writer| {
                    copy_verified(&mut source, writer, &asset)
                })
            });
            reached.wait();
            assert!(!target.exists());
            assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
            resume.wait();
            worker.join().unwrap().unwrap();
        });
        assert_eq!(fs::read(&target).unwrap(), data);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    struct FailingReader(bool);

    impl Read for FailingReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if self.0 {
                return Err(io::Error::other("注入源文件读取失败"));
            }
            self.0 = true;
            buffer.fill(9);
            Ok(buffer.len())
        }
    }

    #[test]
    fn partial_source_io_error_drops_staging_file_without_publishing() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("object");
        let asset = MediaAsset {
            sha256: "a".repeat(64),
            bytes: COPY_BUFFER_BYTES as u64 * 2,
            content_type: "application/octet-stream".into(),
        };
        assert!(
            atomic_create(&target, |writer| copy_verified(
                &mut FailingReader(false),
                writer,
                &asset
            ))
            .is_err()
        );
        assert!(!target.exists());
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
    }
}

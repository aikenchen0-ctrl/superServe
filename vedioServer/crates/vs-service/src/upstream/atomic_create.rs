// SPDX-License-Identifier: Apache-2.0
// 改编自 qdrant/qdrant 的 lib/common/common/src/fs/ops.rs，
// 提交222b2e44ab1c3f17e8246396ead6558e45041df7。
// 将覆盖发布改为同目录临时文件的不可覆盖发布；显式同步内容，并在Unix同步目录。
// persist_noclobber不保证临时链接清理与发布一起原子完成；进程崩溃可能留下暂存链接。

use std::{
    fs::File,
    io::{self, BufWriter, Write},
    path::Path,
};

pub(crate) fn atomic_create(
    path: &Path,
    write: impl FnOnce(&mut BufWriter<&mut File>) -> io::Result<()>,
) -> io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    {
        let mut writer = BufWriter::new(temporary.as_file_mut());
        write(&mut writer)?;
        writer.flush()?;
    }
    temporary.as_file().sync_all()?;
    temporary
        .persist_noclobber(path)
        .map_err(|error| error.error)?;
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_write_does_not_publish_or_replace_a_file() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("events.jsonl");
        assert!(
            atomic_create(&target, |writer| {
                writer.write_all(b"partial")?;
                Err(io::Error::other("injected"))
            })
            .is_err()
        );
        assert!(!target.exists());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
        atomic_create(&target, |writer| writer.write_all(b"complete")).unwrap();
        assert!(atomic_create(&target, |writer| writer.write_all(b"replaced")).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"complete");
    }
}

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::{DomainError, valid_id};

pub const MAX_ITEMS: usize = 10_000;

/// 目录只存公开候选；私有资料必须经过独立的授权投影。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublicCatalog {
    pub version: String,
    pub items: Vec<Candidate>,
    pub assets: Vec<MediaAsset>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Candidate {
    pub id: String,
    pub domain: String,
    pub tags: Vec<String>,
    pub prior: f32,
    pub media_sha256: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MediaAsset {
    pub sha256: String,
    pub bytes: u64,
    pub content_type: String,
}

impl MediaAsset {
    pub fn object_key(&self) -> String {
        format!("media/{}", self.sha256)
    }

    pub fn validate(&self) -> Result<(), DomainError> {
        if self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || self.bytes == 0
            || self.bytes > 100 * 1024 * 1024 * 1024
            || !matches!(
                self.content_type.as_str(),
                "video/mp4"
                    | "video/webm"
                    | "audio/mp4"
                    | "application/octet-stream"
                    | "application/vnd.apple.mpegurl"
            )
        {
            return Err(DomainError::Invalid("media_asset"));
        }
        Ok(())
    }
}

impl PublicCatalog {
    pub fn validate(&self) -> Result<(), DomainError> {
        if !valid_id(&self.version) || self.items.len() > MAX_ITEMS || self.assets.len() > MAX_ITEMS
        {
            return Err(DomainError::Invalid("catalog_size_or_version"));
        }
        let mut assets = HashSet::new();
        for asset in &self.assets {
            asset.validate()?;
            if !assets.insert(asset.sha256.as_str()) {
                return Err(DomainError::Invalid("media_asset"));
            }
        }
        let mut ids = HashSet::new();
        for item in &self.items {
            if !valid_id(&item.id)
                || !valid_id(&item.domain)
                || !ids.insert(item.id.as_str())
                || item.tags.len() > 32
                || item.tags.iter().any(|tag| !valid_id(tag))
                || item.tags.iter().collect::<HashSet<_>>().len() != item.tags.len()
                || !item.prior.is_finite()
                || !(0.0..=1.0).contains(&item.prior)
                || item
                    .media_sha256
                    .as_ref()
                    .is_some_and(|hash| !assets.contains(hash.as_str()))
            {
                return Err(DomainError::Invalid("candidate"));
            }
        }
        Ok(())
    }
}

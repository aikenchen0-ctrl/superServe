use std::sync::Arc;

use vs_core::{
    catalog::{Candidate, MAX_ITEMS, PublicCatalog},
    recommendation::{Interest, ProfileProjection, RecommendationRequest},
};

#[cfg(test)]
pub fn catalog(size: usize, groups: usize) -> Result<Arc<PublicCatalog>, String> {
    catalog_with_variant(size, groups, false)
}

pub fn catalog_with_variant(
    size: usize,
    groups: usize,
    varied: bool,
) -> Result<Arc<PublicCatalog>, String> {
    if !(1..=MAX_ITEMS).contains(&size) || !(1..=size).contains(&groups) {
        return Err("目录规模必须为 1 至 10000，组数必须为 1 至目录规模。".into());
    }
    let mut items: Vec<_> = (0..size)
        .map(|i| {
            let group = i % groups;
            Candidate {
                id: format!("item-{i:05}"),
                domain: ["video", "article", "service"][group % 3].into(),
                tags: vec![
                    if varied && group.is_multiple_of(4) {
                        "unknown-positive"
                    } else {
                        "positive"
                    }
                    .into(),
                    if varied && group.is_multiple_of(3) {
                        "unknown-negative"
                    } else {
                        "negative"
                    }
                    .into(),
                    if varied && group.is_multiple_of(7) {
                        "unknown-anchor"
                    } else {
                        "anchor"
                    }
                    .into(),
                    "zero-a".into(),
                    "zero-b".into(),
                    "zero-c".into(),
                    format!("group-{group:05}"),
                    if group.is_multiple_of(5) {
                        "excluded"
                    } else {
                        "allowed"
                    }
                    .into(),
                ],
                prior: ((i * 7919 + 17) % 10007) as f32 / 10007.0,
                media_sha256: None,
            }
        })
        .collect();
    items.rotate_left(size / 3);
    Ok(Arc::new(PublicCatalog {
        version: format!("cost-n{size}-g{groups}"),
        items,
        assets: vec![],
    }))
}

pub fn request(size: usize, filtered: bool, limit: usize) -> RecommendationRequest {
    RecommendationRequest {
        request_id: "cost-query".into(),
        domains: if filtered {
            vec!["video".into(), "article".into()]
        } else {
            vec!["video".into(), "article".into(), "service".into()]
        },
        limit,
        profile: Some(ProfileProjection {
            subject: "synthetic-user".into(),
            version: "cost-profile-v1".into(),
            scopes: vec!["video".into(), "article".into(), "service".into()],
            expires_at: 100,
            interests: vec![
                Interest {
                    tag: "positive".into(),
                    weight: 1.0,
                },
                Interest {
                    tag: "negative".into(),
                    weight: -0.65,
                },
                Interest {
                    tag: "anchor".into(),
                    weight: 0.25,
                },
            ],
            blocked_ids: if filtered {
                (0..size)
                    .step_by(17)
                    .take(64)
                    .map(|i| format!("item-{i:05}"))
                    .collect()
            } else {
                vec![]
            },
            denied_tags: if filtered {
                vec!["excluded".into()]
            } else {
                vec![]
            },
        }),
    }
}

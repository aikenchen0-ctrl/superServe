use str0m::format::{Codec, CodecConfig, PayloadParams};
use str0m::media::Frequency;

use crate::RelayError;

pub(crate) fn select(
    offered: &[PayloadParams],
    source: Option<PayloadParams>,
) -> Result<PayloadParams, RelayError> {
    offered
        .iter()
        .copied()
        .find(|params| {
            let spec = params.spec();
            let supported = match spec.codec {
                Codec::Vp8 => true,
                Codec::H264 => {
                    spec.format.packetization_mode == Some(1)
                        && spec.format.profile_level_id == Some(0x42e01f)
                }
                _ => false,
            };
            supported
                && spec.clock_rate == Frequency::NINETY_KHZ
                && spec.channels.is_none()
                && source.is_none_or(|source| {
                    // 上游H264匹配允许级别降协商；透传不转码，额外要求同一固定级别与封包模式。
                    let expected = source.spec();
                    expected.codec == spec.codec
                        && (spec.codec != Codec::H264
                            || expected.format.profile_level_id == spec.format.profile_level_id
                                && expected.format.packetization_mode
                                    == spec.format.packetization_mode)
                        && CodecConfig::new_from_payload_params(vec![source])
                            .match_params(*params)
                            .is_some()
                })
        })
        .ok_or(if source.is_some() {
            RelayError::Conflict
        } else {
            RelayError::Invalid
        })
}

pub(crate) fn name(codec: Codec) -> &'static str {
    match codec {
        Codec::Vp8 => "vp8",
        Codec::H264 => "h264",
        _ => "unsupported",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h264(profile: u32, mode: bool, pt: u8) -> PayloadParams {
        let mut config = CodecConfig::empty();
        config.add_h264(pt.into(), None, mode, profile);
        config.params()[0]
    }

    #[test]
    fn passthrough_refuses_profile_level_mode_and_cross_codec_mismatches_but_remaps_pt() {
        let source = h264(0x42e01f, true, 108);
        let viewer = h264(0x42e01f, true, 102);
        assert_eq!(select(&[viewer], Some(source)).unwrap().pt(), viewer.pt());
        for incompatible in [
            h264(0x42001f, true, 102),
            h264(0x64001f, true, 102),
            h264(0x42e01e, true, 102),
            h264(0x42e01f, false, 102),
        ] {
            assert!(matches!(
                select(&[incompatible], Some(source)),
                Err(RelayError::Conflict)
            ));
            assert!(matches!(
                select(&[incompatible], None),
                Err(RelayError::Invalid)
            ));
        }
        for spec in [
            str0m::format::CodecSpec {
                clock_rate: Frequency::FORTY_EIGHT_KHZ,
                ..source.spec()
            },
            str0m::format::CodecSpec {
                channels: Some(2),
                ..source.spec()
            },
        ] {
            let invalid = PayloadParams::new(102.into(), None, spec);
            assert!(matches!(select(&[invalid], None), Err(RelayError::Invalid)));
        }
        let mut config = CodecConfig::empty();
        config.enable_vp8(true);
        let vp8 = config.params()[0];
        assert!(matches!(
            select(&[vp8], Some(source)),
            Err(RelayError::Conflict)
        ));
        assert!(matches!(
            select(&[source], Some(vp8)),
            Err(RelayError::Conflict)
        ));
        assert_eq!(
            select(&[vp8, viewer], Some(source)).unwrap().pt(),
            viewer.pt()
        );
    }
}

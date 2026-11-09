use str0m::{
    format::{Codec, CodecConfig, PayloadParams},
    media::Frequency,
};

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
            spec.codec == Codec::Opus
                && spec.clock_rate == Frequency::FORTY_EIGHT_KHZ
                && spec.channels == Some(2)
                && !spec.format.stereo.unwrap_or(false)
                && !spec.format.sprop_stereo.unwrap_or(false)
                && params.red().is_none()
                && params.resend().is_none()
                && source.is_none_or(|source| {
                    CodecConfig::new_from_payload_params(vec![source])
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

#[cfg(test)]
mod tests {
    use super::*;
    use str0m::format::CodecSpec;

    #[test]
    fn mono_opus_uses_rtp_two_channel_mapping_and_rejects_unsupported_formats() {
        let mut config = CodecConfig::empty();
        config.enable_opus(true, false);
        let original = config.params()[0];
        let alternate = PayloadParams::new(112.into(), None, original.spec());
        assert_eq!(
            select(&[alternate], Some(original)).unwrap().pt(),
            alternate.pt()
        );
        let rtx = PayloadParams::new(111.into(), Some(97.into()), original.spec());
        assert!(matches!(select(&[rtx], None), Err(RelayError::Invalid)));
        for spec in [
            CodecSpec {
                channels: Some(1),
                ..original.spec()
            },
            CodecSpec {
                clock_rate: Frequency::EIGHT_KHZ,
                ..original.spec()
            },
            CodecSpec {
                codec: Codec::PCMU,
                ..original.spec()
            },
            CodecSpec {
                format: str0m::format::FormatParams {
                    stereo: Some(true),
                    ..original.spec().format
                },
                ..original.spec()
            },
            CodecSpec {
                format: str0m::format::FormatParams {
                    sprop_stereo: Some(true),
                    ..original.spec().format
                },
                ..original.spec()
            },
        ] {
            assert!(matches!(
                select(&[PayloadParams::new(112.into(), None, spec)], None),
                Err(RelayError::Invalid)
            ));
        }
    }
}

use std::collections::VecDeque;
use str0m::media::MediaData;

use crate::RelayStats;

const MAX_VIDEO_BYTES: usize = 256 * 1024;
const MAX_VIDEO_FRAMES: usize = 8;
// 小于固定str0m默认MTU扣除SRTP后的负载预算，避免上游把Opus包任意切片。
const MAX_AUDIO_BYTES: usize = 1024;
const MAX_AUDIO_PACKETS: usize = 16;

#[derive(Default)]
pub(crate) struct MediaQueues {
    video: VecDeque<MediaData>,
    audio: VecDeque<MediaData>,
}

impl MediaQueues {
    pub(crate) fn push(&mut self, data: MediaData, stats: &mut RelayStats) -> bool {
        let audio = data.params.spec().codec.is_audio();
        if data.rid.is_some()
            || data.data.len()
                > if audio {
                    MAX_AUDIO_BYTES
                } else {
                    MAX_VIDEO_BYTES
                }
        {
            if audio {
                stats.dropped_audio_packets += 1;
            } else {
                stats.dropped_frames += 1;
            }
            return false;
        }
        let queue = if audio {
            &mut self.audio
        } else {
            &mut self.video
        };
        if queue.len()
            >= if audio {
                MAX_AUDIO_PACKETS
            } else {
                MAX_VIDEO_FRAMES
            }
        {
            if audio {
                // 音频只保留较新数据；视频拥塞不能耗尽音频保留槽位。
                queue.pop_front();
                stats.dropped_audio_packets += 1;
            } else {
                stats.dropped_frames += 1;
                return false;
            }
        }
        queue.push_back(data);
        let audio_bytes = self.audio.iter().map(|packet| packet.data.len()).sum();
        let video_bytes = self
            .video
            .iter()
            .map(|frame| frame.data.len())
            .sum::<usize>();
        stats.audio_queue_peak_bytes = stats.audio_queue_peak_bytes.max(audio_bytes);
        stats.queue_peak_bytes = stats.queue_peak_bytes.max(video_bytes + audio_bytes);
        true
    }

    pub(crate) fn pop(&mut self) -> Option<MediaData> {
        self.audio.pop_front().or_else(|| self.video.pop_front())
    }

    pub(crate) fn clear(&mut self) {
        self.audio.clear();
        self.video.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::Arc, time::Instant};
    use str0m::{
        format::{CodecConfig, CodecExtra},
        media::{Frequency, MediaTime},
    };

    fn data(audio: bool, sequence: u64, bytes: usize) -> MediaData {
        let mut config = CodecConfig::empty();
        if audio {
            config.enable_opus(true, false);
        } else {
            config.enable_vp8(true);
        }
        MediaData {
            mid: if audio {
                "audio".into()
            } else {
                "video".into()
            },
            pt: config.params()[0].pt(),
            rid: None,
            params: config.params()[0],
            time: MediaTime::new(
                sequence,
                if audio {
                    Frequency::FORTY_EIGHT_KHZ
                } else {
                    Frequency::NINETY_KHZ
                },
            ),
            network_time: Instant::now(),
            seq_range: sequence.into()..=sequence.into(),
            contiguous: true,
            data: Arc::from(vec![0; bytes]),
            ext_vals: Default::default(),
            codec_extra: CodecExtra::None,
            last_sender_info: None,
            audio_start_of_talk_spurt: false,
        }
    }

    #[test]
    fn video_pressure_cannot_consume_audio_slots_and_audio_drops_stale_packets() {
        let mut queues = MediaQueues::default();
        let mut stats = RelayStats::default();
        for index in 0..MAX_VIDEO_FRAMES {
            assert!(queues.push(data(false, index as u64, 256), &mut stats));
        }
        assert!(!queues.push(data(false, 99, 256), &mut stats));
        for index in 0..=MAX_AUDIO_PACKETS {
            assert!(queues.push(data(true, index as u64, 64), &mut stats));
        }
        assert_eq!(stats.dropped_frames, 1);
        assert_eq!(stats.dropped_audio_packets, 1);
        for index in 1..=MAX_AUDIO_PACKETS {
            let packet = queues.pop().unwrap();
            assert!(packet.params.spec().codec.is_audio());
            assert_eq!(**packet.seq_range.start(), index as u64);
        }
        assert!(queues.pop().unwrap().params.spec().codec.is_video());
        queues.clear();
        assert!(queues.pop().is_none());
    }

    #[test]
    fn oversized_audio_is_rejected_without_consuming_video_or_audio_capacity() {
        let mut queues = MediaQueues::default();
        let mut stats = RelayStats::default();
        assert!(!queues.push(data(true, 1, MAX_AUDIO_BYTES + 1), &mut stats));
        assert!(!queues.push(data(false, 1, MAX_VIDEO_BYTES + 1), &mut stats));
        assert_eq!(stats.dropped_audio_packets, 1);
        assert_eq!(stats.dropped_frames, 1);
        assert!(queues.pop().is_none());
        assert!(queues.push(data(true, 2, MAX_AUDIO_BYTES), &mut stats));
        assert_eq!(queues.pop().unwrap().data.len(), MAX_AUDIO_BYTES);
    }
}

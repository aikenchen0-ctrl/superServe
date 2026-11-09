// SPDX-License-Identifier: Apache-2.0
// 按Media3 1.11.1 LoadControl生命周期接线；分配器、起播和实际I/O继续归原播放器。
package org.superserve.playback.media3

import androidx.media3.common.C
import androidx.media3.common.Timeline
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.LoadControl
import androidx.media3.exoplayer.analytics.PlayerId
import androidx.media3.exoplayer.source.MediaSource.MediaPeriodId
import androidx.media3.exoplayer.source.TrackGroupArray
import androidx.media3.exoplayer.trackselection.ExoTrackSelection
import androidx.media3.exoplayer.upstream.Allocator
import org.superserve.playback.NativeTimeBufferControl
import org.superserve.playback.PlaybackException
import kotlin.math.ceil

/**
 * 显式点播时间门；一个实例只供一个播放器，并只在播放器线程调用。
 * 不提供在途请求取消或字节上限；完整票据适配器不能由LoadControl参数推导。
 */
@UnstableApi
class RustTimeLoadControl(
    private val delegate: LoadControl,
    private val minimumMs: UInt,
    private val maximumMs: UInt,
) : LoadControl {
    private var gate: NativeTimeBufferControl? = null
    private var player: PlayerId? = null
    private var ownerThread: Thread? = null
    private var periodId: MediaPeriodId? = null
    private var lastPositionUs: Long? = null
    private var armed = false
    private var disabled = false
    private val period = Timeline.Period()
    private val window = Timeline.Window()

    init {
        // 让Rust校验策略，不在Kotlin复制阈值规则；实例不长期持构造线程资源。
        NativeTimeBufferControl(minimumMs, maximumMs).close()
    }

    private fun checkOwner(playerId: PlayerId) {
        check(ownerThread === Thread.currentThread() && player === playerId) {
            "时间门仅允许已准备的单个播放器在原播放线程调用"
        }
    }

    private fun checkLifecycleOwner(playerId: PlayerId) {
        check(ownerThread == null || ownerThread === Thread.currentThread()) {
            "时间门不能跨播放线程共享"
        }
        check(player == null || player === playerId) { "每个时间门只能属于一个播放器" }
    }

    private fun resetGate() {
        armed = false
        try {
            gate?.reset()
        } catch (_: PlaybackException) {
            disabled = true
        }
    }

    private fun eligible(parameters: LoadControl.Parameters): Boolean {
        if (periodId != parameters.mediaPeriodId ||
            lastPositionUs?.let { parameters.playbackPositionUs < it } == true) {
            resetGate()
            periodId = parameters.mediaPeriodId
        }
        lastPositionUs = parameters.playbackPositionUs
        if (disabled || parameters.rebuffering || parameters.playbackPositionUs < 0 ||
            parameters.targetLiveOffsetUs != C.TIME_UNSET || parameters.mediaPeriodId.isAd ||
            parameters.timeline.isEmpty) {
            resetGate()
            return false
        }
        val index = parameters.timeline.getIndexOfPeriod(parameters.mediaPeriodId.periodUid)
        if (index == C.INDEX_UNSET) {
            resetGate()
            return false
        }
        parameters.timeline.getPeriod(index, period)
        parameters.timeline.getWindow(period.windowIndex, window)
        if (window.isLive || window.isDynamic) {
            resetGate()
            return false
        }
        if (parameters.bufferedDurationUs !in 0..86_400_000_000L ||
            !parameters.playbackSpeed.isFinite() || parameters.playbackSpeed !in 0.25f..4.0f) {
            disabled = true
            resetGate()
            return false
        }
        return true
    }

    override fun onPrepared(playerId: PlayerId) {
        checkLifecycleOwner(playerId)
        delegate.onPrepared(playerId)
        ownerThread = Thread.currentThread()
        player = playerId
        gate?.close()
        gate = NativeTimeBufferControl(minimumMs, maximumMs)
        periodId = null
        lastPositionUs = null
        armed = false
        disabled = false
    }

    override fun shouldStartPlayback(parameters: LoadControl.Parameters): Boolean {
        checkOwner(parameters.playerId)
        val original = delegate.shouldStartPlayback(parameters)
        val applicable = eligible(parameters)
        armed = original && applicable
        if (!armed) resetGate()
        return original
    }

    // Java默认方法不能依赖Kotlin by隐式转发；按固定发布接口逐项保留委托。
    override fun getAllocator(playerId: PlayerId): Allocator = delegate.getAllocator(playerId)

    override fun getBackBufferDurationUs(playerId: PlayerId): Long =
        delegate.getBackBufferDurationUs(playerId)

    override fun retainBackBufferFromKeyframe(playerId: PlayerId): Boolean =
        delegate.retainBackBufferFromKeyframe(playerId)

    override fun onTracksSelected(
        parameters: LoadControl.Parameters,
        trackGroups: TrackGroupArray,
        trackSelections: Array<out ExoTrackSelection?>,
    ) {
        checkOwner(parameters.playerId)
        delegate.onTracksSelected(parameters, trackGroups, trackSelections)
        resetGate()
    }

    override fun shouldContinuePreloading(
        playerId: PlayerId,
        timeline: Timeline,
        mediaPeriodId: MediaPeriodId,
        bufferedDurationUs: Long,
    ): Boolean = delegate.shouldContinuePreloading(
        playerId, timeline, mediaPeriodId, bufferedDurationUs,
    )

    override fun shouldContinueLoading(parameters: LoadControl.Parameters): Boolean {
        checkOwner(parameters.playerId)
        val original = delegate.shouldContinueLoading(parameters)
        if (!eligible(parameters) || !armed) return original
        val nativeGate = gate ?: return original
        return try {
            // 时长向下取整、倍速向上取整；不把次毫秒余量当作已达到水位。
            val permit = nativeGate.shouldLoad(
                (parameters.bufferedDurationUs / 1000).toUInt(),
                ceil(parameters.playbackSpeed.toDouble() * 1000).toUInt(),
            )
            original && permit
        } catch (_: PlaybackException) {
            disabled = true
            armed = false
            original
        }
    }

    override fun onStopped(playerId: PlayerId) {
        checkLifecycleOwner(playerId)
        try {
            delegate.onStopped(playerId)
        } finally {
            gate?.close()
            gate = null
            armed = false
        }
    }

    override fun onReleased(playerId: PlayerId) {
        checkLifecycleOwner(playerId)
        try {
            delegate.onReleased(playerId)
        } finally {
            gate?.close()
            gate = null
            player = null
            ownerThread = null
            armed = false
        }
    }
}

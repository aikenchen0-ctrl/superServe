// SPDX-License-Identifier: Apache-2.0
package org.superserve.playback.media3

import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Timeline
import androidx.media3.exoplayer.LoadControl
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.analytics.PlayerId
import androidx.media3.exoplayer.source.MediaSource.MediaPeriodId
import androidx.media3.exoplayer.source.TrackGroupArray
import androidx.media3.exoplayer.trackselection.ExoTrackSelection
import androidx.media3.exoplayer.upstream.Allocator
import java.lang.reflect.Proxy
import org.superserve.playback.media3.TraceRequestHeaders

// 使用发布包的真实Timeline/Parameters；仅委托策略可控，不替换Media3接口或Rust。
private class TestTimeline(
    val uid: Any = Any(),
    private val live: Boolean = false,
    private val dynamic: Boolean = false,
) : Timeline() {
    override fun getWindowCount() = 1
    override fun getPeriodCount() = 1
    override fun getUidOfPeriod(index: Int): Any = uid
    override fun getIndexOfPeriod(candidate: Any): Int = if (candidate === uid) 0 else C.INDEX_UNSET
    override fun getPeriod(index: Int, period: Period, setIds: Boolean): Period {
        check(index == 0)
        period.windowIndex = 0
        return period
    }
    override fun getWindow(index: Int, window: Window, projectionUs: Long): Window {
        check(index == 0)
        window.isDynamic = dynamic
        window.liveConfiguration = if (live) MediaItem.LiveConfiguration.UNSET else null
        return window
    }
}

private class Delegate : LoadControl {
    var continueLoading = true
    var startPlayback = true
    var prepared = 0
    var stopped = 0
    var released = 0
    var loadingCalls = 0
    var startCalls = 0
    var trackCalls = 0
    var preloadCalls = 0
    val allocator = Proxy.newProxyInstance(
        Allocator::class.java.classLoader,
        arrayOf(Allocator::class.java),
    ) { _, method, _ ->
        when (method.name) {
            "getTotalBytesAllocated", "getIndividualAllocationLength" -> 0
            else -> null
        }
    } as Allocator

    override fun onPrepared(playerId: PlayerId) { prepared++ }
    override fun onStopped(playerId: PlayerId) { stopped++ }
    override fun onReleased(playerId: PlayerId) { released++ }
    override fun getAllocator(playerId: PlayerId) = allocator
    override fun getBackBufferDurationUs(playerId: PlayerId) = 1234L
    override fun retainBackBufferFromKeyframe(playerId: PlayerId) = true
    override fun shouldContinueLoading(parameters: LoadControl.Parameters): Boolean {
        loadingCalls++
        return continueLoading
    }
    override fun shouldStartPlayback(parameters: LoadControl.Parameters): Boolean {
        startCalls++
        return startPlayback
    }
    override fun onTracksSelected(
        parameters: LoadControl.Parameters,
        trackGroups: TrackGroupArray,
        trackSelections: Array<out ExoTrackSelection?>,
    ) { trackCalls++ }
    override fun shouldContinuePreloading(
        playerId: PlayerId, timeline: Timeline, periodId: MediaPeriodId, bufferedDurationUs: Long,
    ): Boolean {
        preloadCalls++
        return false
    }
}

private fun parameters(
    player: PlayerId,
    timeline: TestTimeline,
    bufferUs: Long,
    positionUs: Long = 1_000_000,
    speed: Float = 1f,
    rebuffering: Boolean = false,
    target: Long = C.TIME_UNSET,
    periodId: MediaPeriodId = MediaPeriodId(timeline.uid, 1L),
) = LoadControl.Parameters(
    player, timeline, periodId, positionUs, bufferUs, speed, true, rebuffering, target, C.TIME_UNSET,
)

private fun basicHysteresisAndStartup(): Int {
    val player = PlayerId("jvm-test")
    val timeline = TestTimeline()
    val delegate = Delegate()
    val control = RustTimeLoadControl(delegate, 2000u, 4000u)
    control.onPrepared(player)
    check(control.shouldContinueLoading(parameters(player, timeline, 20_000_000)))
    delegate.startPlayback = false
    check(!control.shouldStartPlayback(parameters(player, timeline, 20_000_000)))
    check(control.shouldContinueLoading(parameters(player, timeline, 20_000_000)))
    delegate.startPlayback = true
    check(control.shouldStartPlayback(parameters(player, timeline, 1_000_000)))
    for ((buffer, expected) in listOf(0L to true, 4_000_000L to false, 3_000_000L to false, 1_999_999L to true)) {
        check(control.shouldContinueLoading(parameters(player, timeline, buffer)) == expected)
    }
    delegate.continueLoading = false
    check(!control.shouldContinueLoading(parameters(player, timeline, 0)))
    check(control.getAllocator(player) === delegate.allocator)
    check(control.getBackBufferDurationUs(player) == 1234L)
    check(control.retainBackBufferFromKeyframe(player))
    control.onTracksSelected(parameters(player, timeline, 0), TrackGroupArray.EMPTY, emptyArray())
    check(delegate.trackCalls == 1)
    check(!control.shouldContinuePreloading(player, timeline, MediaPeriodId(timeline.uid), 0))
    check(delegate.preloadCalls == 1)
    control.onStopped(player)
    control.onReleased(player)
    check(delegate.prepared == 1 && delegate.stopped == 1 && delegate.released == 1)
    return 1
}

private fun fallbackAndBoundaries(): Int {
    var cases = 0
    for (kind in listOf("live", "dynamic", "rebuffer", "future", "ad", "target", "invalid-speed", "long-buffer")) {
        val player = PlayerId("jvm-test")
        val timeline = TestTimeline(live = kind == "live", dynamic = kind == "dynamic")
        val delegate = Delegate()
        val control = RustTimeLoadControl(delegate, 2000u, 4000u)
        control.onPrepared(player)
        control.shouldStartPlayback(parameters(player, timeline, 1_000_000))
        val params = parameters(
            player, timeline,
            if (kind == "long-buffer") 86_400_000_001L else 5_000_000,
            positionUs = if (kind == "future") -1 else 1_000_000,
            speed = if (kind == "invalid-speed") Float.NaN else 1f,
            rebuffering = kind == "rebuffer",
            target = if (kind == "target") 3_000_000 else C.TIME_UNSET,
            periodId = if (kind == "ad") MediaPeriodId(timeline.uid, 0, 0, 1L)
                else MediaPeriodId(timeline.uid, 1L),
        )
        check(control.shouldContinueLoading(params))
        control.onStopped(player)
        control.onReleased(player)
        cases++
    }
    return cases
}

private fun resetAndOwnership(): Int {
    val player = PlayerId("jvm-test")
    val timeline = TestTimeline()
    val delegate = Delegate()
    val control = RustTimeLoadControl(delegate, 2000u, 4000u)
    control.onPrepared(player)
    control.shouldStartPlayback(parameters(player, timeline, 1_000_000, positionUs = 2_000_000))
    check(!control.shouldContinueLoading(parameters(player, timeline, 4_000_000, positionUs = 2_000_000)))
    check(control.shouldContinueLoading(parameters(player, timeline, 5_000_000, positionUs = 1_000_000)))
    check(control.shouldStartPlayback(parameters(player, timeline, 1_000_000)))
    check(!control.shouldContinueLoading(parameters(player, timeline, 5_000_000)))
    delegate.startPlayback = false
    check(!control.shouldStartPlayback(parameters(player, timeline, 5_000_000)))
    check(control.shouldContinueLoading(parameters(player, timeline, 5_000_000)))
    delegate.startPlayback = true
    check(control.shouldStartPlayback(parameters(player, timeline, 1_000_000)))
    val replacement = TestTimeline()
    check(control.shouldContinueLoading(parameters(player, replacement, 5_000_000)))
    var foreignRejected = false
    try {
        control.onPrepared(PlayerId("other"))
    } catch (_: IllegalStateException) { foreignRejected = true }
    check(foreignRejected && delegate.prepared == 1)
    var threadRejected = false
    val thread = Thread {
        try {
            control.shouldContinueLoading(parameters(player, replacement, 0))
        } catch (_: IllegalStateException) { threadRejected = true }
    }
    thread.start()
    thread.join()
    check(threadRejected)
    control.onStopped(player)
    control.onPrepared(player)
    check(control.shouldContinueLoading(parameters(player, timeline, 5_000_000)))
    control.onReleased(player)
    return 1
}

private fun actualDefaultLoadControl(): Int {
    val player = PlayerId("actual-default")
    val timeline = TestTimeline()
    val original = DefaultLoadControl.Builder()
        .setBufferDurationsMs(5000, 10000, 1000, 2000)
        .setPrioritizeTimeOverSizeThresholds(false)
        .build()
    val control = RustTimeLoadControl(original, 2000u, 4000u)
    control.onPrepared(player)
    check(control.shouldContinueLoading(parameters(player, timeline, 0)))
    check(!control.shouldStartPlayback(parameters(player, timeline, 500_000)))
    check(control.shouldContinueLoading(parameters(player, timeline, 4_000_000)))
    check(control.shouldStartPlayback(parameters(player, timeline, 1_000_000)))
    check(!control.shouldContinueLoading(parameters(player, timeline, 4_000_000)))
    check(control.shouldContinueLoading(parameters(player, timeline, 1_999_000)))
    check(control.getAllocator(player).totalBytesAllocated == 0)
    control.onStopped(player)
    control.onReleased(player)
    return 1
}

private fun rateAndTimeRounding(): Int {
    val player = PlayerId("rounding")
    val timeline = TestTimeline()
    val delegate = Delegate()
    val control = RustTimeLoadControl(delegate, 2000u, 4000u)
    control.onPrepared(player)
    check(control.shouldStartPlayback(parameters(player, timeline, 1_000_000)))
    check(!control.shouldContinueLoading(parameters(player, timeline, 4_000_000)))
    check(control.shouldContinueLoading(parameters(player, timeline, 3_000_999, speed = 1.5001f)))
    check(!control.shouldContinueLoading(parameters(player, timeline, 4_000_000, speed = 2f)))
    check(control.shouldContinueLoading(parameters(player, timeline, 3_999_999, speed = 2f)))
    control.onReleased(player)
    return 1
}

private fun cleanupWithoutPreparation(): Int {
    val player = PlayerId("never-prepared")
    val delegate = Delegate()
    val control = RustTimeLoadControl(delegate, 2000u, 4000u)
    control.onStopped(player)
    control.onReleased(player)
    check(delegate.prepared == 0 && delegate.stopped == 1 && delegate.released == 1)
    control.onPrepared(player)
    control.onReleased(player)
    check(delegate.prepared == 1 && delegate.released == 2)
    return 1
}

fun main() {
    check(TraceRequestHeaders.properties(
        "4bf92f3577b34da6a3ce929d0e0e4736", "request-1"
    ) == mapOf(
        "x-vs-trace-id" to "4bf92f3577b34da6a3ce929d0e0e4736",
        "x-vs-request-id" to "request-1",
    ))
    check(TraceRequestHeaders.properties("4BF92F3577B34DA6A3CE929D0E0E4736").isEmpty())
    check(TraceRequestHeaders.properties("00000000000000000000000000000000").isEmpty())
    check(TraceRequestHeaders.properties(null, "../subject").isEmpty())
    val cases = basicHysteresisAndStartup() + fallbackAndBoundaries() + resetAndOwnership() +
        actualDefaultLoadControl() + rateAndTimeRounding() + cleanupWithoutPreparation()
    println("""{"schema":"media3-native-time-consumer-v1","passed":true,"scenario_groups":$cases,"actual_media3_classes":true,"actual_default_load_control":true,"actual_rust_dll":true,"android_sdk_stubs_only":true,"android_player_or_device_verified":false}""")
}

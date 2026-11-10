// SPDX-License-Identifier: Apache-2.0
// 生命周期沿用Media3官方demo的onStart创建/onStop释放；仅本地合成视频，无网络权限。
package org.superserve.playback.lab

import android.app.Activity
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.SurfaceView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.datasource.DefaultHttpDataSource
import org.json.JSONObject
import org.superserve.playback.NativeTimeBufferControl
import org.superserve.playback.media3.RustTimeLoadControl
import org.superserve.playback.media3.TraceRequestHeaders
import java.io.File

class PlaybackLabActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var surface: SurfaceView
    private lateinit var status: TextView
    private var player: ExoPlayer? = null
    private var runId = ""
    private var mode = ""
    private var firstFrameMs: Long? = null
    private var decoder: String? = null
    private var observedPositionMs = 0L
    private var maximumPositionMs = 0L
    private var bufferingTransitions = 0
    private var startedAt = 0L
    private var nativeProbe = false
    private var completed = false
    private var released = false
    private var error: String? = null
    private var ended = false
    private var canStart = false
    private val traceId: String? by lazy {
        TraceRequestHeaders.normalize(intent.getStringExtra("trace_id"))
    }
    private val requestId: String? by lazy {
        TraceRequestHeaders.normalizeRequestId(intent.getStringExtra("request_id"))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        runId = intent.getStringExtra("run_id").orEmpty()
        mode = intent.getStringExtra("mode").orEmpty()
        canStart = runId.matches(Regex("[a-z0-9-]{1,48}")) && mode in listOf("baseline", "rust")
        surface = SurfaceView(this)
        status = TextView(this).apply {
            setTextColor(Color.BLACK)
            textSize = 16f
            text = if (canStart) "准备播放" else "实验参数无效"
        }
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
            setPadding(16, 32, 16, 16)
            addView(surface, LinearLayout.LayoutParams(-1, 0, 1f))
            addView(status, LinearLayout.LayoutParams(-1, -2))
        }
        setContentView(layout)
        if (canStart && File(filesDir, "$runId.json").exists()) {
            canStart = false
            status.text = "实验记录已存在"
        }
    }

    override fun onStart() {
        super.onStart()
        if (!canStart || player != null || completed) return
        startedAt = SystemClock.elapsedRealtime()
        try {
            // 两模式都先验证相同Rust/JNA加载，基线仅不把门接入Media3。
            NativeTimeBufferControl(2000u, 4000u).use { gate ->
                check(gate.shouldLoad(0u, 1000u))
                check(!gate.shouldLoad(4000u, 1000u))
                nativeProbe = true
            }
            val original = DefaultLoadControl.Builder().build()
            val control = if (mode == "rust") RustTimeLoadControl(original, 2000u, 4000u) else original
            // 固定MP4路径，按实际依赖创建默认提取器；不注入额外协议或任意URL。
            val httpFactory = DefaultHttpDataSource.Factory()
                .setDefaultRequestProperties(TraceRequestHeaders.properties(traceId, requestId))
            val factory = DefaultMediaSourceFactory(this, DefaultExtractorsFactory())
                .setDataSourceFactory(httpFactory)
            val instance = ExoPlayer.Builder(this).setLoadControl(control)
                .setMediaSourceFactory(factory).build()
            player = instance
            instance.addAnalyticsListener(object : AnalyticsListener {
                override fun onRenderedFirstFrame(
                    eventTime: AnalyticsListener.EventTime, output: Any, renderTimeMs: Long,
                ) {
                    if (firstFrameMs == null) firstFrameMs = SystemClock.elapsedRealtime() - startedAt
                    status.text = "播放中"
                }
                override fun onVideoDecoderInitialized(
                    eventTime: AnalyticsListener.EventTime, decoderName: String,
                    initializedTimestampMs: Long, initializationDurationMs: Long,
                ) { decoder = decoderName }
            })
            instance.addListener(object : Player.Listener {
                override fun onPlaybackStateChanged(state: Int) {
                    if (state == Player.STATE_BUFFERING) bufferingTransitions++
                    if (state == Player.STATE_ENDED) {
                        ended = true
                        finishRun("ended")
                    }
                }
                override fun onPlayerError(failure: PlaybackException) {
                    error = failure.errorCodeName
                    finishRun("playback_error")
                }
            })
            instance.setVideoSurfaceView(surface)
            instance.volume = 0f
            instance.setMediaItem(MediaItem.fromUri(Uri.parse("asset:///source.mp4")))
            instance.prepare()
            instance.playWhenReady = true
            handler.post(tick)
            handler.postDelayed({ finishRun("deadline") }, 20_000)
        } catch (failure: Throwable) {
            error = failure.javaClass.name + ": " + failure.message.orEmpty().take(240)
            finishRun("initialization_error")
        }
    }

    private val tick = object : Runnable {
        override fun run() {
            if (completed) return
            player?.let {
                observedPositionMs = it.currentPosition
                maximumPositionMs = maxOf(maximumPositionMs, observedPositionMs)
            }
            if (firstFrameMs != null && maximumPositionMs >= 2500) {
                finishRun("observed_playback")
            } else handler.postDelayed(this, 100)
        }
    }

    private fun finishRun(reason: String) {
        if (completed) return
        completed = true
        handler.removeCallbacksAndMessages(null)
        player?.let {
            observedPositionMs = it.currentPosition
            maximumPositionMs = maxOf(maximumPositionMs, observedPositionMs)
            try {
                it.release()
                released = true
            } catch (failure: Throwable) {
                error = failure.javaClass.name
            } finally { player = null }
        }
        val passed = nativeProbe && firstFrameMs != null && decoder != null &&
            maximumPositionMs >= 2500 && released && error == null
        val result = JSONObject().apply {
            put("schema", "android-player-device-v1")
            put("run_id", runId)
            put("mode", mode)
            put("passed", passed)
            put("reason", reason)
            put("rust_jna_loaded", nativeProbe)
            put("first_frame_callback_ms", firstFrameMs ?: JSONObject.NULL)
            put("decoder", decoder ?: JSONObject.NULL)
            put("position_ms", maximumPositionMs)
            put("buffering_transitions", bufferingTransitions)
            put("ended", ended)
            put("player_released", released)
            put("error", error ?: JSONObject.NULL)
            put("sdk", android.os.Build.VERSION.SDK_INT)
            put("abi", android.os.Build.SUPPORTED_ABIS.first())
            put("network_used", false)
            put("real_user_or_three_low_benchmark", false)
        }
        File(filesDir, "$runId.json").writeText(result.toString())
        status.text = if (passed) "播放验证完成" else "播放验证失败"
    }

    override fun onStop() {
        if (canStart && !completed) finishRun("activity_stopped")
        super.onStop()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }
}

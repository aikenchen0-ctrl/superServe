// SPDX-License-Identifier: Apache-2.0
package org.superserve.playback.consumer

import android.content.Context
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import org.superserve.playback.NativeTimeBufferControl
import org.superserve.playback.media3.RustTimeLoadControl

/** 只验证公开二进制接口可消费；本入口尚未在Android运行。 */
fun createPlayer(context: Context): ExoPlayer {
    val control = RustTimeLoadControl(
        DefaultLoadControl.Builder().build(),
        minimumMs = 2000u,
        maximumMs = 4000u,
    )
    return ExoPlayer.Builder(context).setLoadControl(control).build()
}

/** 从重新提取的AAR类调用真实Rust库；不得冒称Android播放器加载成功。 */
fun main() {
    NativeTimeBufferControl(2000u, 4000u).use { gate ->
        check(gate.shouldLoad(0u, 1000u))
        check(!gate.shouldLoad(4000u, 1000u))
        check(!gate.shouldLoad(3000u, 1000u))
        gate.reset()
        check(gate.shouldLoad(1999u, 1000u))
    }
    println("""{"schema":"android-aar-packaged-consumer-v1","passed":true,"packaged_classes_and_host_dll":true,"android_runtime_verified":false}""")
}

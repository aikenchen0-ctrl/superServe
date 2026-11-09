import org.superserve.playback.*

private fun policy() = BufferPolicy(2000u, 4000u, 1000u, 2000u, 65536uL)

private fun observation(
    sequence: ULong,
    generation: ULong = 1uL,
    activity: Activity = Activity.ACTIVE,
) = PlayerObservation(
    generation, sequence, sequence * 10uL, 0uL, listOf(emptyList(), emptyList()),
    0uL, activity, 1000u, false, false,
)

fun main() {
    // use确保外语对象句柄在正常和异常路径均释放；票据仍只由Rust创建。
    NativePlayer(policy()).use { player ->
        val first = player.update(observation(1uL), 1024uL)
        check(first.reason == DecisionReason.LOAD)
        first.request!!.use { ticket ->
            check(ticket.bytes() == 1024uL)
            check(player.transferFinished(ticket, 1024uL, TransferResult.COMPLETE) ==
                TransferCompletion.READY_FOR_APPEND)
            val waiting = player.update(observation(2uL), null)
            check(waiting.inFlightBytes == 1024uL && !waiting.startPlayback)
            val appended = observation(3uL).copy(
                tracks = listOf(listOf(BufferRange(0uL, 4000uL)), listOf(BufferRange(0uL, 4000uL))),
                bufferedBytes = 1024uL,
            )
            check(player.appended(ticket, appended, null).startPlayback)
            check(!player.release(ticket))
        }
    }
    NativePlayer(policy()).use { player ->
        NativePlayer(policy()).use { other ->
            player.update(observation(1uL), 512uL).request!!.use { ticket ->
                other.update(observation(1uL), 512uL).request!!.use { foreign ->
                    check(!player.release(foreign))
                    check(player.transferFinished(foreign, 512uL, TransferResult.COMPLETE) ==
                        TransferCompletion.STALE)
                }
                val changed = player.changeGeneration()
                check(changed.generation == 2uL)
                changed.cancel!!.close()
                var rejected = false
                try {
                    player.update(observation(2uL), 512uL)
                } catch (_: PlaybackException.InvalidInput) {
                    rejected = true
                }
                check(rejected)
                check(player.transferFinished(ticket, 512uL, TransferResult.COMPLETE) ==
                    TransferCompletion.DISCARDED)
                player.update(observation(1uL, 2uL), null).also {
                    check(it.reason == DecisionReason.AWAITING_FRAGMENT)
                }
            }
        }
    }
    println("""{"schema":"native-kotlin-jvm-binding-v1","passed":true,"real_generated_binding_and_dll":true,"android_device_verified":false}""")
}

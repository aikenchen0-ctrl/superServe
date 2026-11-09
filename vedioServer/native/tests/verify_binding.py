"""验证实际生成绑定与Rust动态库，不把宿主调用等同Android/iOS真机。"""

import json
import sys
import unittest

sys.path.insert(0, sys.argv.pop(1))
import vs_playback_native as native


def policy():
    return native.BufferPolicy(
        min_buffer_ms=2000, max_buffer_ms=4000, start_buffer_ms=1000,
        rebuffer_ms=2000, max_buffer_bytes=65536,
    )


def observation(sequence, generation=1, activity=native.Activity.ACTIVE):
    return native.PlayerObservation(
        generation=generation, sequence=sequence, monotonic_ms=sequence * 10,
        position_ms=0, tracks=[[], []], buffered_bytes=0, activity=activity,
        playback_rate_milli=1000, rebuffering=False, end_of_stream=False,
    )


class BindingTests(unittest.TestCase):
    def test_time_only_gate_reuses_hysteresis_and_typed_errors(self):
        gate = native.NativeTimeBufferControl(2000, 4000)
        for buffered, expected in [(0, True), (4000, False), (3000, False), (1999, True)]:
            self.assertEqual(gate.should_load(buffered, 1000), expected)
        with self.assertRaises(native.PlaybackError.InvalidInput):
            gate.should_load(1000, 0)
        gate.reset()
        self.assertFalse(gate.should_load(3000, 1000))

    def test_download_requires_append_and_keeps_native_ticket(self):
        player = native.NativePlayer(policy())
        first = player.update(observation(1), 1024)
        self.assertEqual(first.reason, native.DecisionReason.LOAD)
        ticket = first.request
        self.assertEqual(ticket.bytes(), 1024)
        self.assertEqual(ticket.generation(), 1)
        self.assertEqual(
            player.transfer_finished(ticket, 1024, native.TransferResult.COMPLETE),
            native.TransferCompletion.READY_FOR_APPEND,
        )
        waiting = player.update(observation(2), 1024)
        self.assertEqual(waiting.in_flight_bytes, 1024)
        self.assertFalse(waiting.start_playback)
        appended = observation(3)
        appended.tracks = [[native.BufferRange(start_ms=0, end_ms=4000)] for _ in range(2)]
        appended.buffered_bytes = 1024
        update = player.appended(ticket, appended, None)
        self.assertEqual(update.buffered_media_ms, 4000)
        self.assertTrue(update.start_playback)
        self.assertIsNone(update.request)
        self.assertFalse(player.release(ticket))
        with self.assertRaises(ValueError):
            native.DownloadTicket()

    def test_old_generation_and_foreign_ticket_cannot_release_new_budget(self):
        player = native.NativePlayer(policy())
        other = native.NativePlayer(policy())
        ticket = player.update(observation(1), 512).request
        foreign = other.update(observation(1), 512).request
        self.assertFalse(player.release(foreign))
        self.assertEqual(
            player.transfer_finished(foreign, 512, native.TransferResult.COMPLETE),
            native.TransferCompletion.STALE,
        )
        changed = player.change_generation()
        self.assertEqual(changed.generation, 2)
        self.assertEqual(changed.cancel.bytes(), 512)
        with self.assertRaises(native.PlaybackError.InvalidInput):
            player.update(observation(2), 512)
        self.assertEqual(
            player.transfer_finished(ticket, 512, native.TransferResult.COMPLETE),
            native.TransferCompletion.DISCARDED,
        )
        next_ticket = player.update(observation(1, generation=2), 1024).request
        self.assertEqual(next_ticket.generation(), 2)
        self.assertFalse(player.release(ticket))
        self.assertTrue(player.release(next_ticket))

    def test_errors_preserve_state_and_unknown_length(self):
        player = native.NativePlayer(policy())
        invalid = observation(1)
        invalid.tracks = []
        with self.assertRaises(native.PlaybackError.InvalidInput):
            player.update(invalid, 1024)
        update = player.update(observation(1), None)
        self.assertEqual(update.reason, native.DecisionReason.AWAITING_FRAGMENT)
        self.assertIsNone(update.request)
        with self.assertRaises(native.PlaybackError.InvalidInput):
            player.update(observation(1), 1024)
        ticket = player.update(observation(2), 1024).request
        self.assertEqual(
            player.transfer_finished(ticket, 1023, native.TransferResult.COMPLETE),
            native.TransferCompletion.LENGTH_MISMATCH,
        )
        next_ticket = player.update(observation(3), 1024).request
        self.assertEqual(
            player.transfer_finished(next_ticket, 10, native.TransferResult.FAILED),
            native.TransferCompletion.DISCARDED,
        )

    def test_pause_hide_seek_need_explicit_release(self):
        for activity in [native.Activity.PAUSED, native.Activity.HIDDEN, native.Activity.SEEKING]:
            with self.subTest(activity=activity):
                player = native.NativePlayer(policy())
                ticket = player.update(observation(1), 1024).request
                update = player.update(observation(2, activity=activity), None)
                self.assertTrue(update.cancel_in_flight)
                self.assertEqual(update.cancel.bytes(), 1024)
                self.assertTrue(player.release(ticket))
                self.assertFalse(player.release(ticket))


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(BindingTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful():
        raise SystemExit(1)
    print(json.dumps({
        "schema": "native-python-binding-v1", "passed": True,
        "cases": result.testsRun, "real_generated_binding_and_dll": True,
        "android_ios_or_performance_verified": False,
    }))

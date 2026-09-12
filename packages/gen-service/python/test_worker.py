#!/usr/bin/env python3
"""
Unit tests for worker.py — modality dispatch routing, the run_audio / run_3d
NDJSON event shape, and the trellis `--serve` persistent-loop framing.

Stdlib `unittest` only (no pytest / no mlx-audio): the subprocess-driving seams
(`synthesize_audio` / `synthesize_3d`) are monkeypatched, and `emit` is captured,
so the tests are fast and dependency-free. The REAL mlx-audio synthesis is proven
separately by an end-to-end smoke (Kokoro-82M -> real .wav), out of band.

Run:  cd packages/gen-service/python && python3 -m unittest -v
"""

import json
import os
import sys
import tempfile
import unittest
from contextlib import contextmanager

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import worker  # noqa: E402


@contextmanager
def capture_events():
    """Swap worker.emit for a collector; yield the captured event list."""
    events = []
    original = worker.emit
    worker.emit = events.append
    try:
        yield events
    finally:
        worker.emit = original


@contextmanager
def patched(**attrs):
    """Temporarily set module attributes on `worker` (restore after)."""
    saved = {k: getattr(worker, k) for k in attrs}
    for k, v in attrs.items():
        setattr(worker, k, v)
    try:
        yield
    finally:
        for k, v in saved.items():
            setattr(worker, k, v)


def kinds(events):
    return [e["event"] for e in events]


class DispatchRoutingTest(unittest.TestCase):
    def _dispatch_records(self, modality):
        """Route through dispatch() with each handler replaced by a recorder."""
        called = {}

        def rec(name):
            def fn(job, *a, **k):
                called["name"] = name
                called["job"] = job
                return 0
            return fn

        with patched(run_image=rec("image"), run_audio=rec("audio"), run_3d=rec("3d")):
            with capture_events() as events:
                rc = worker.dispatch({"id": "j1", "modality": modality})
        return called, events, rc

    def test_image_routes_to_run_image(self):
        called, _, rc = self._dispatch_records("image")
        self.assertEqual(called["name"], "image")
        self.assertEqual(rc, 0)

    def test_audio_routes_to_run_audio(self):
        called, _, rc = self._dispatch_records("audio")
        self.assertEqual(called["name"], "audio")
        self.assertEqual(rc, 0)

    def test_3d_routes_to_run_3d(self):
        called, _, rc = self._dispatch_records("3d")
        self.assertEqual(called["name"], "3d")
        self.assertEqual(rc, 0)

    def test_video_is_rejected_with_comfy_pointer(self):
        with capture_events() as events:
            rc = worker.dispatch({"id": "jv", "modality": "video"})
        self.assertEqual(rc, 1)
        self.assertEqual(kinds(events), ["error"])
        self.assertIn("ComfyUI", events[0]["message"])
        self.assertEqual(events[0]["jobId"], "jv")

    def test_unknown_modality_errors(self):
        with capture_events() as events:
            rc = worker.dispatch({"id": "jx", "modality": "hologram"})
        self.assertEqual(rc, 1)
        self.assertEqual(kinds(events), ["error"])
        self.assertIn("unsupported modality", events[0]["message"])


class RunAudioTest(unittest.TestCase):
    def test_ndjson_shape_single_candidate(self):
        with tempfile.TemporaryDirectory() as d:
            def fake_synth(job_id, spec, seed, idx, out_dir):
                p = os.path.join(out_dir, f"cand{idx}_seed{seed}.wav")
                open(p, "wb").close()
                return p

            job = {
                "id": "a1",
                "modality": "audio",
                "outputDir": d,
                "audio": {
                    "prompt": "hello world",
                    "modelId": "kokoro-82m",
                    "mlxAudioModel": "prince-canuma/Kokoro-82M",
                    "seeds": [0],
                },
            }
            with patched(synthesize_audio=fake_synth):
                with capture_events() as events:
                    rc = worker.run_audio(job)

        self.assertEqual(rc, 0)
        self.assertEqual(kinds(events), ["start", "progress", "candidate", "done"])
        start = events[0]
        self.assertEqual(start["total"], 1)
        self.assertEqual(start["candidates"], 1)
        prog = events[1]
        self.assertEqual((prog["step"], prog["total"], prog["candidate"]), (1, 1, 0))
        cand = events[2]
        self.assertEqual(cand["index"], 0)
        out = cand["output"]
        self.assertEqual(out["modality"], "audio")
        self.assertEqual(out["model"], "kokoro-82m")
        self.assertEqual(out["seed"], 0)
        self.assertTrue(out["outputPath"].endswith(".wav"))
        done = events[3]
        self.assertEqual(len(done["outputs"]), 1)

    def test_multiple_seeds_produce_multiple_candidates(self):
        with tempfile.TemporaryDirectory() as d:
            def fake_synth(job_id, spec, seed, idx, out_dir):
                p = os.path.join(out_dir, f"c{idx}.wav")
                open(p, "wb").close()
                return p

            job = {
                "id": "a2",
                "modality": "audio",
                "outputDir": d,
                "audio": {
                    "prompt": "hi",
                    "modelId": "kokoro-82m",
                    "mlxAudioModel": "prince-canuma/Kokoro-82M",
                    "seeds": [1, 2, 3],
                },
            }
            with patched(synthesize_audio=fake_synth):
                with capture_events() as events:
                    worker.run_audio(job)

        self.assertEqual(
            kinds(events),
            [
                "start",
                "progress",
                "candidate",
                "progress",
                "candidate",
                "progress",
                "candidate",
                "done",
            ],
        )
        cand_seeds = [e["output"]["seed"] for e in events if e["event"] == "candidate"]
        self.assertEqual(cand_seeds, [1, 2, 3])
        self.assertEqual(events[0]["candidates"], 3)

    def test_missing_spec_errors(self):
        with capture_events() as events:
            rc = worker.run_audio({"id": "a3", "modality": "audio", "outputDir": "/tmp"})
        self.assertEqual(rc, 1)
        self.assertEqual(kinds(events), ["error"])
        self.assertIn("audio", events[0]["message"])

    def test_missing_prompt_errors(self):
        job = {"id": "a4", "modality": "audio", "outputDir": "/tmp", "audio": {"modelId": "k"}}
        with capture_events() as events:
            rc = worker.run_audio(job)
        self.assertEqual(rc, 1)
        self.assertEqual(kinds(events), ["error"])
        self.assertIn("prompt", events[0]["message"])


class BuildMfluxImg2ImgTest(unittest.TestCase):
    """The one place in the app where `strength` is turned upside down.

    mflux reads `--image-strength` as the fraction of the denoising schedule to
    SKIP, so a bigger number lands CLOSER to the original -- the reverse of
    diffusers, of the agent tool's parameter, and of what anyone typing a number
    expects. worker.py inverts on the way out (see the comment there). If that
    inversion is ever dropped, every edit in the app quietly does the opposite of
    what was asked and still succeeds, which is exactly the kind of bug no
    end-to-end run catches.
    """

    BASE = {"mfluxCommand": "mflux-generate", "prompt": "p"}

    def cmd(self, **extra):
        return worker.build_mflux_cmd({**self.BASE, **extra}, 7, "/out.png", "/steps")

    def test_no_image_means_no_img2img_flags(self):
        cmd = self.cmd()
        self.assertNotIn("--image-path", cmd)
        self.assertNotIn("--image-strength", cmd)

    def test_image_path_is_passed_through(self):
        cmd = self.cmd(imagePath="/in.png")
        self.assertEqual(cmd[cmd.index("--image-path") + 1], "/in.png")

    def test_strength_is_inverted_for_mflux(self):
        # 0.8 = "change it a lot" -> mflux keeps 0.2 of the schedule.
        cmd = self.cmd(imagePath="/in.png", imageStrength=0.8)
        self.assertEqual(float(cmd[cmd.index("--image-strength") + 1]), 0.2)
        # 0.3 = "touch it up" -> mflux keeps 0.7, starting late in the schedule.
        cmd = self.cmd(imagePath="/in.png", imageStrength=0.3)
        self.assertEqual(float(cmd[cmd.index("--image-strength") + 1]), 0.7)

    def test_more_change_always_means_a_smaller_mflux_number(self):
        def keep(change):
            c = self.cmd(imagePath="/in.png", imageStrength=change)
            return float(c[c.index("--image-strength") + 1])

        values = [keep(x) for x in (0.1, 0.3, 0.5, 0.7, 0.9)]
        self.assertEqual(values, sorted(values, reverse=True))

    def test_out_of_range_is_clamped_not_passed_on(self):
        cmd = self.cmd(imagePath="/in.png", imageStrength=1.7)
        self.assertEqual(float(cmd[cmd.index("--image-strength") + 1]), 0.0)
        cmd = self.cmd(imagePath="/in.png", imageStrength=-0.4)
        self.assertEqual(float(cmd[cmd.index("--image-strength") + 1]), 1.0)

    def test_strength_without_an_image_is_ignored(self):
        self.assertNotIn("--image-strength", self.cmd(imageStrength=0.5))


class BuildAudioCmdTest(unittest.TestCase):
    def test_builds_expected_argv(self):
        spec = {
            "prompt": "say this",
            "mlxAudioModel": "prince-canuma/Kokoro-82M",
            "voice": "af_heart",
            "speed": 1.0,
            "lang": "a",
        }
        cmd = worker.build_audio_cmd(spec, "cand0_seed0", "/out", "wav")
        # Driven via THIS interpreter so it uses worker.py's uv env.
        self.assertEqual(cmd[:3], [sys.executable, "-m", "mlx_audio.tts.generate"])
        self.assertEqual(cmd[cmd.index("--model") + 1], "prince-canuma/Kokoro-82M")
        self.assertEqual(cmd[cmd.index("--text") + 1], "say this")
        self.assertEqual(cmd[cmd.index("--audio_format") + 1], "wav")
        self.assertEqual(cmd[cmd.index("--file_prefix") + 1], "cand0_seed0")
        self.assertEqual(cmd[cmd.index("--output_path") + 1], "/out")
        self.assertEqual(cmd[cmd.index("--voice") + 1], "af_heart")
        self.assertEqual(cmd[cmd.index("--lang_code") + 1], "a")

    def test_missing_model_raises(self):
        with self.assertRaises(RuntimeError):
            worker.build_audio_cmd({"prompt": "x"}, "p", "/out", "wav")

    def test_omits_optional_flags(self):
        cmd = worker.build_audio_cmd(
            {"prompt": "x", "mlxAudioModel": "m"}, "p", "/out", "wav"
        )
        self.assertNotIn("--voice", cmd)
        self.assertNotIn("--speed", cmd)
        self.assertNotIn("--lang_code", cmd)
        self.assertNotIn("--ref_audio", cmd)
        self.assertNotIn("--ref_text", cmd)

    def test_ref_audio_and_ref_text_clone_flags(self):
        spec = {
            "prompt": "clone me",
            "mlxAudioModel": "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
            "refAudio": "/refs/sample.wav",
            "refText": "the quick brown fox",
        }
        cmd = worker.build_audio_cmd(spec, "p", "/out", "wav")
        self.assertEqual(cmd[cmd.index("--ref_audio") + 1], "/refs/sample.wav")
        self.assertEqual(cmd[cmd.index("--ref_text") + 1], "the quick brown fox")

    def test_ref_text_is_omitted_without_ref_audio(self):
        # ref_text is only meaningful alongside a reference clip.
        cmd = worker.build_audio_cmd(
            {"prompt": "x", "mlxAudioModel": "m", "refText": "orphan"}, "p", "/out", "wav"
        )
        self.assertNotIn("--ref_audio", cmd)
        self.assertNotIn("--ref_text", cmd)

    def test_ref_audio_without_ref_text_is_allowed(self):
        cmd = worker.build_audio_cmd(
            {"prompt": "x", "mlxAudioModel": "m", "refAudio": "/r.wav"}, "p", "/out", "wav"
        )
        self.assertEqual(cmd[cmd.index("--ref_audio") + 1], "/r.wav")
        self.assertNotIn("--ref_text", cmd)


class FindAudioOutputTest(unittest.TestCase):
    def test_finds_index_suffixed_file(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "cand0_seed0_000.wav")
            open(p, "wb").close()
            self.assertEqual(worker.find_audio_output(d, "cand0_seed0", "wav"), p)

    def test_returns_none_when_absent(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(worker.find_audio_output(d, "nope", "wav"))


class Run3dTest(unittest.TestCase):
    def test_ndjson_shape(self):
        with tempfile.TemporaryDirectory() as d:
            def fake_synth(job_id, spec, seed, idx, out_dir, pipeline=None):
                p = os.path.join(out_dir, f"c{idx}.glb")
                open(p, "wb").close()
                return p

            job = {
                "id": "d1",
                "modality": "3d",
                "outputDir": d,
                "threed": {"modelId": "triposr", "inputImage": "/img.png", "seeds": [7]},
            }
            with patched(synthesize_3d=fake_synth):
                with capture_events() as events:
                    rc = worker.run_3d(job)

        self.assertEqual(rc, 0)
        self.assertEqual(kinds(events), ["start", "progress", "candidate", "done"])
        out = events[2]["output"]
        self.assertEqual(out["modality"], "3d")
        self.assertEqual(out["model"], "triposr")
        self.assertEqual(out["seed"], 7)

    def test_accepts_3d_key_alias(self):
        with tempfile.TemporaryDirectory() as d:
            def fake_synth(job_id, spec, seed, idx, out_dir, pipeline=None):
                p = os.path.join(out_dir, f"c{idx}.glb")
                open(p, "wb").close()
                return p

            job = {"id": "d2", "modality": "3d", "outputDir": d, "3d": {"seeds": [0]}}
            with patched(synthesize_3d=fake_synth):
                with capture_events() as events:
                    rc = worker.run_3d(job)
        self.assertEqual(rc, 0)
        self.assertIn("done", kinds(events))

    def test_missing_spec_errors(self):
        with capture_events() as events:
            rc = worker.run_3d({"id": "d3", "modality": "3d", "outputDir": "/tmp"})
        self.assertEqual(rc, 1)
        self.assertEqual(kinds(events), ["error"])


class Synthesize3dGateTest(unittest.TestCase):
    def test_deferred_gate_without_command_raises(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(RuntimeError) as ctx:
                worker.synthesize_3d("d", {"inputImage": "/i.png"}, 0, 0, d)
            self.assertIn("deferred", str(ctx.exception).lower())

    def test_build_3d_cmd_substitutes_tokens(self):
        spec = {
            "inputImage": "/in.png",
            "resolution": 1024,
            "command": ["triposr", "{input}", "--out", "{output}", "--seed", "{seed}", "--res", "{resolution}"],
        }
        cmd = worker.build_3d_cmd(spec, "/out/c0.glb", 42)
        self.assertEqual(
            cmd,
            ["triposr", "/in.png", "--out", "/out/c0.glb", "--seed", "42", "--res", "1024"],
        )

    def test_build_3d_cmd_none_without_template(self):
        self.assertIsNone(worker.build_3d_cmd({"inputImage": "/i.png"}, "/o.glb", 0))


class ServeLoopTest(unittest.TestCase):
    def _fake_synth(self, out_dir_holder):
        def fn(job_id, spec, seed, idx, out_dir, pipeline=None):
            out_dir_holder.append(pipeline)
            p = os.path.join(out_dir, f"{job_id}_c{idx}.glb")
            open(p, "wb").close()
            return p
        return fn

    def test_ready_log_then_per_job_framing_then_shutdown(self):
        with tempfile.TemporaryDirectory() as d:
            lines = [
                json.dumps({"id": "s1", "modality": "3d", "outputDir": d, "threed": {"seeds": [0]}}),
                json.dumps({"id": "s2", "modality": "3d", "outputDir": d, "threed": {"seeds": [0]}}),
                json.dumps({"type": "shutdown"}),
                json.dumps({"id": "s3", "outputDir": d, "threed": {"seeds": [0]}}),  # never reached
            ]
            seen_pipelines = []
            with patched(synthesize_3d=self._fake_synth(seen_pipelines)):
                with capture_events() as events:
                    rc = worker.serve_loop(stdin=iter(lines))

        self.assertEqual(rc, 0)
        # First event: readiness log with the serve sentinel id.
        self.assertEqual(events[0]["event"], "log")
        self.assertEqual(events[0]["jobId"], worker.SERVE_JOB_ID)
        self.assertIn("ready", events[0]["text"])
        # Last event: stop log.
        self.assertEqual(events[-1]["event"], "log")
        self.assertIn("stopped", events[-1]["text"])
        # Two jobs ran (s3 after shutdown never reached); each fully framed by its id.
        job_ids = [e["jobId"] for e in events if e.get("jobId") in ("s1", "s2", "s3")]
        self.assertEqual(set(job_ids), {"s1", "s2"})
        s1 = [e["event"] for e in events if e.get("jobId") == "s1"]
        self.assertEqual(s1, ["start", "progress", "candidate", "done"])
        # The SAME loaded pipeline handle threads through to every asset.
        self.assertTrue(seen_pipelines)
        self.assertEqual(len({id(p) for p in seen_pipelines}), 1)

    def test_bad_line_errors_but_loop_survives(self):
        with tempfile.TemporaryDirectory() as d:
            lines = [
                "not json at all",
                json.dumps({"id": "ok", "modality": "3d", "outputDir": d, "threed": {"seeds": [0]}}),
            ]
            with patched(synthesize_3d=self._fake_synth([])):
                with capture_events() as events:
                    worker.serve_loop(stdin=iter(lines))
        # A parse error for the bad line, then the good job still completes.
        self.assertTrue(
            any(e["event"] == "error" and e["jobId"] == worker.SERVE_JOB_ID for e in events)
        )
        self.assertTrue(any(e["event"] == "done" and e.get("jobId") == "ok" for e in events))

    def test_failing_job_does_not_kill_loop(self):
        with tempfile.TemporaryDirectory() as d:
            def boom(job_id, spec, seed, idx, out_dir, pipeline=None):
                raise RuntimeError("synthesis blew up")

            good = self._fake_synth([])
            calls = {"n": 0}

            def synth(job_id, spec, seed, idx, out_dir, pipeline=None):
                calls["n"] += 1
                if job_id == "bad":
                    return boom(job_id, spec, seed, idx, out_dir, pipeline)
                return good(job_id, spec, seed, idx, out_dir, pipeline)

            lines = [
                json.dumps({"id": "bad", "modality": "3d", "outputDir": d, "threed": {"seeds": [0]}}),
                json.dumps({"id": "after", "modality": "3d", "outputDir": d, "threed": {"seeds": [0]}}),
            ]
            with patched(synthesize_3d=synth):
                with capture_events() as events:
                    worker.serve_loop(stdin=iter(lines))

        # The failing job emits an error keyed to its id...
        self.assertTrue(any(e["event"] == "error" and e.get("jobId") == "bad" for e in events))
        # ...but the next job still runs to completion (pipeline stayed resident).
        self.assertTrue(any(e["event"] == "done" and e.get("jobId") == "after" for e in events))

    def test_eof_stops_cleanly(self):
        with patched(synthesize_3d=self._fake_synth([])):
            with capture_events() as events:
                rc = worker.serve_loop(stdin=iter([]))
        self.assertEqual(rc, 0)
        self.assertEqual([e["event"] for e in events], ["log", "log"])

    def test_pipeline_load_failure_is_terminal(self):
        def boom():
            raise RuntimeError("weights missing")

        with capture_events() as events:
            rc = worker.serve_loop(stdin=iter([]), load_pipeline=boom)
        self.assertEqual(rc, 1)
        self.assertEqual(events[0]["event"], "error")
        self.assertIn("load failed", events[0]["message"])


class MainServeFlagTest(unittest.TestCase):
    def test_serve_flag_enters_serve_loop(self):
        called = {}

        def fake_serve():
            called["yes"] = True
            return 0

        with patched(serve_loop=fake_serve):
            rc = worker.main(argv=["--serve"])
        self.assertEqual(rc, 0)
        self.assertTrue(called.get("yes"))


if __name__ == "__main__":
    unittest.main()


class TestStepPreviews:
    """Per-step previews are an admission decision now (~4.5 GB at 512², MEASURED)."""

    BASE = {"mfluxCommand": "mflux-generate", "prompt": "p"}

    def test_default_keeps_previews(self):
        cmd = worker.build_mflux_cmd(dict(self.BASE), 7, "/out.png", "/steps")
        assert "--stepwise-image-output-dir" in cmd

    def test_off_when_the_machine_cannot_afford_them(self):
        cmd = worker.build_mflux_cmd({**self.BASE, "stepPreviews": False}, 7, "/out.png", "/steps")
        assert "--stepwise-image-output-dir" not in cmd
        assert "--output" in cmd


class TestLowRam:
    """mflux's memory saver is on for every job (MEASURED: half the memory,
    the same pixels, no slower); the flag exists so a caller can measure without it."""

    BASE = {"mfluxCommand": "mflux-generate-flux2", "prompt": "p"}

    def test_default_is_low_ram(self):
        cmd = worker.build_mflux_cmd(dict(self.BASE), 7, "/out.png", "/steps")
        assert "--low-ram" in cmd
        assert cmd.index("--low-ram") < cmd.index("--output")

    def test_can_be_switched_off(self):
        cmd = worker.build_mflux_cmd({**self.BASE, "lowRam": False}, 7, "/out.png", "/steps")
        assert "--low-ram" not in cmd


class PacerTests(unittest.TestCase):
    """The 'low' power lever: a child is rested for `pace` of every second and
    never left stopped — the user: "low can't stop image generation requests, it
    just has to lessen compute intensivity … sacrificing speed to keep headroom"."""

    def test_pace_zero_starts_no_thread(self):
        import subprocess

        proc = subprocess.Popen([sys.executable, "-c", "pass"])
        pacer = worker.Pacer(proc, 0)
        self.assertIsNone(pacer.thread)
        pacer.close()
        self.assertEqual(proc.wait(timeout=5), 0)

    def test_pace_is_clamped(self):
        import subprocess

        proc = subprocess.Popen([sys.executable, "-c", "pass"])
        pacer = worker.Pacer(proc, 5)
        self.assertEqual(pacer.pace, 0.8)
        pacer.close()
        proc.wait(timeout=5)

    def test_paced_child_is_rested_and_finishes(self):
        """A child that counts wall-clock ticks sees fewer of its own CPU
        seconds when paced, and still exits cleanly with SIGCONT delivered."""
        import subprocess
        import time

        script = (
            "import time,os\n"
            "t0=time.process_time(); w0=time.monotonic()\n"
            "while time.monotonic()-w0 < 2.4:\n"
            "    sum(range(20000))\n"
            "print(time.process_time()-t0)\n"
        )
        proc = subprocess.Popen(
            [sys.executable, "-c", script], stdout=subprocess.PIPE, text=True
        )
        pacer = worker.Pacer(proc, 0.5)
        out, _ = proc.communicate(timeout=30)
        pacer.close()
        self.assertEqual(proc.returncode, 0)
        cpu = float(out.strip())
        # Half of every second stopped: well under the 2.4 s of wall time it
        # spun for (flat out it uses ~all of it).
        self.assertLess(cpu, 1.9, f"child used {cpu:.2f}s CPU in 2.4s wall — not paced")
        self.assertGreater(cpu, 0.3)

    def test_drive_subprocess_emits_pacing_log(self):
        with capture_events() as events:
            rc = worker.drive_subprocess("j1", [sys.executable, "-c", "print('hi')"], pace=0.35)
        self.assertEqual(rc, 0)
        logs = [e for e in events if e.get("event") == "log"]
        self.assertTrue(any("Low power" in e["text"] and "35%" in e["text"] for e in logs), logs)

    def test_drive_subprocess_flat_out_has_no_pacing_log(self):
        with capture_events() as events:
            worker.drive_subprocess("j1", [sys.executable, "-c", "print('hi')"])
        self.assertFalse(any("Low power" in e.get("text", "") for e in events), events)


class TailTests(unittest.TestCase):
    """A failed child's last lines travel with the error — "exited with code 1"
    alone sent the asking model off to try another model (SEEN)."""

    def test_drain_keeps_a_bounded_tail_without_progress_frames(self):
        import io

        keep = []
        stream = io.StringIO("loading\n" + "\n".join(f"line {i}" for i in range(30)) + "\n 50%|#####     | 2/4\nTraceback: boom\n")
        with capture_events():
            worker.drain_output("j", stream, keep=keep)
        self.assertLessEqual(len(keep), worker.TAIL_LINES)
        self.assertEqual(keep[-1], "Traceback: boom")
        text = worker.tail_text(keep)
        self.assertIn("Traceback: boom", text)
        self.assertNotIn("50%|", text)

    def test_run_one_error_names_the_cause(self):
        import subprocess as sp

        spec = {"mfluxCommand": sys.executable, "prompt": "p"}
        # A "generator" that prints a reason and fails.
        real_build = worker.build_mflux_cmd
        worker.build_mflux_cmd = lambda *_a, **_k: [
            sys.executable,
            "-c",
            "import sys; print('ValueError: weights for flux1-schnell not found'); sys.exit(1)",
        ]
        try:
            with tempfile.TemporaryDirectory() as out_dir, capture_events():
                with self.assertRaises(RuntimeError) as ctx:
                    worker.run_one("j", spec, 7, 0, out_dir, 4)
            self.assertIn("exited with code 1", str(ctx.exception))
            self.assertIn("weights for flux1-schnell not found", str(ctx.exception))
        finally:
            worker.build_mflux_cmd = real_build

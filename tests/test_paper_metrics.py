"""Paper monitoring only accepts real command output, never guesses tick rate."""
import unittest
from server.paper_metrics import PaperMetrics


class PaperMetricsTests(unittest.TestCase):
    def test_unavailable_before_paper_reports(self):
        metrics=PaperMetrics()
        self.assertEqual(metrics.snapshot(),{"tps":None,"mspt":None})
        metrics.observe("[INFO]: Can't keep up! Running 5000ms behind")
        self.assertEqual(metrics.snapshot(),{"tps":None,"mspt":None})

    def test_paper_reports_tps_and_min_avg_max_mspt(self):
        metrics=PaperMetrics()
        metrics.observe("[12:30 INFO]: TPS from last 1m, 5m, 15m: *19.93, *19.99, *20.0")
        metrics.observe("[12:30 INFO]: Tick durations (min/avg/max) from last 5s, 10s, 1m:")
        metrics.observe("[12:30 INFO]: 1.2/6.4/33.5, 1.0/6.0/35.0, 1.3/7.3/55.0")
        self.assertEqual(metrics.snapshot(),{"tps":19.93,"mspt":6.4})

    def test_paper_inline_mspt_and_colored_tps(self):
        metrics=PaperMetrics()
        metrics.observe("[INFO]: TPS from last 1m, 5m, 15m: §a*20.0, §a*20.0, §a*20.0")
        metrics.observe("[INFO]: MSPT from last 5s, 10s, 1m: 4.8, 5.0, 5.5")
        self.assertEqual(metrics.snapshot(),{"tps":20.0,"mspt":4.8})

    def test_player_chat_cannot_spoof_performance(self):
        metrics=PaperMetrics()
        metrics.observe("[12:30 INFO]: <Griefer> TPS from last 1m: 0.1")
        metrics.observe("[12:30 INFO]: <Griefer> MSPT from last 5s: 8000")
        self.assertEqual(metrics.snapshot(),{"tps":None,"mspt":None})

    def test_stale_samples_are_not_presented_as_live(self):
        metrics=PaperMetrics()
        metrics.observe("[INFO]: TPS from last 1m: 18.5")
        metrics.observe("[INFO]: MSPT from last 5s: 70.2")
        metrics.tps_at-=46
        metrics.mspt_at-=46
        self.assertEqual(metrics.snapshot(),{"tps":None,"mspt":None})

    def test_invalid_numeric_values_never_poison_live_status(self):
        metrics=PaperMetrics()
        metrics.observe("TPS from last 1m: 200")
        metrics.observe("MSPT from last 5s: 900000")
        self.assertEqual(metrics.snapshot(),{"tps":None,"mspt":None})


if __name__=="__main__":
    unittest.main()

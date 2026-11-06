import unittest

from server.restart_policy import Action, RestartPolicy, evaluate


class RestartPolicyTests(unittest.TestCase):
    def test_online_at_hour_continues(self):
        result = evaluate(3600, 3)
        self.assertEqual(result.action, Action.CONTINUE)

    def test_empty_at_hour_restarts(self):
        result = evaluate(3600, 0)
        self.assertEqual(result.action, Action.RESTART)
        self.assertEqual(result.reason, "hourly_zero_players")

    def test_empty_before_hour_does_not_restart(self):
        result = evaluate(3599, 0)
        self.assertEqual(result.action, Action.CONTINUE)

    def test_hourly_restart_even_at_two_hours(self):
        self.assertEqual(evaluate(7200, 0).action, Action.RESTART)

    def test_online_at_deadline_must_restart(self):
        result = evaluate(19800, 5)
        self.assertEqual(result.action, Action.RESTART)
        self.assertEqual(result.reason, "forced_deadline")

    def test_forced_restart_even_with_zero_players(self):
        self.assertEqual(evaluate(19800, 0).action, Action.RESTART)

    def test_five_minute_warning(self):
        result = evaluate(19500, 2)
        self.assertEqual(result.warnings_to_send, (300,))

    def test_one_minute_warning_is_not_repeated(self):
        result = evaluate(19740, 2, previously_sent_warnings={300})
        self.assertEqual(result.warnings_to_send, (60,))

    def test_ten_second_warning(self):
        result = evaluate(19790, 2, previously_sent_warnings={300, 60})
        self.assertEqual(result.warnings_to_send, (10,))

    def test_negative_player_count_is_rejected(self):
        with self.assertRaises(ValueError):
            evaluate(100, -1)


if __name__ == "__main__":
    unittest.main()

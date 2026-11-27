import re
import unittest
from pathlib import Path


class CIWorkflowTests(unittest.TestCase):
    def test_matrix_names_the_three_desktop_runners(self):
        workflow_path = Path(__file__).resolve().parents[4] / ".github/workflows/ci.yml"
        workflow = workflow_path.read_text(encoding="utf-8")
        matrix = re.search(r"(?m)^      matrix:\n        os:\n((?:          - [^\n]+\n)+)", workflow)

        self.assertIsNotNone(matrix, "workflow must define an OS matrix")
        self.assertCountEqual(
            [line.strip().removeprefix("- ") for line in matrix[1].splitlines()],
            ["ubuntu-latest", "windows-latest", "macos-latest"],
        )

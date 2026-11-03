import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class HermesPackageTest(unittest.TestCase):
    def test_root_init_stays_within_twenty_lines(self):
        lines = (ROOT / "__init__.py").read_text(encoding="utf-8").splitlines()
        self.assertLessEqual(len(lines), 20)

    def test_hermes_style_import_exposes_register(self):
        # Hermes loads the directory under an arbitrary module name with the directory as its package path,
        # so the entry point must resolve through relative imports alone.
        name = "lampstand_u0_probe"
        spec = importlib.util.spec_from_file_location(
            name, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)]
        )
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module

        def forget():
            for key in [key for key in sys.modules if key == name or key.startswith(f"{name}.")]:
                del sys.modules[key]

        self.addCleanup(forget)
        spec.loader.exec_module(module)
        self.assertTrue(callable(module.register))


if __name__ == "__main__":
    unittest.main()

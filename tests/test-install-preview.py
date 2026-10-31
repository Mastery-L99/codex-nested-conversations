"""Offline bootstrap regression tests. Run with python -B tests/test-install-preview.py."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest import mock
import zipfile

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("preview", Path(__file__).resolve().parents[1] / "scripts/install-preview.py")
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


def fake_zip(entries):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in entries:
            archive.writestr(name, data)
    return buffer.getvalue()


def read_fixture(data, checksum=None):
    checksum = checksum or hashlib.sha256(data).hexdigest()
    with mock.patch.object(preview, "asset_bytes", side_effect=[(checksum + "  demo.zip\n").encode(), data]):
        return preview.release_files("demo.zip", None)


class BootstrapTests(unittest.TestCase):
    def test_verified_zip_exposes_expected_bytes(self):
        entries = read_fixture(fake_zip([("plugin/plugin.json", b"fixture")]))
        self.assertEqual(entries["plugin/plugin.json"][1], b"fixture")

    def test_mismatched_hash_stops_before_accessing_zip(self):
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            read_fixture(b"not a zip", checksum="0" * 64)

    def test_unsafe_members_are_rejected_even_with_a_matching_zip_digest(self):
        for name in ("../x", ".hidden/../x", "C:relative", "/outside", "CON.py", "x\\..\\outside", "x./y"):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "Unsafe"):
                read_fixture(fake_zip([(name, b"x")]))
        with self.assertRaisesRegex(ValueError, "repeated"):
            read_fixture(fake_zip([("plugin/id", b"x"), ("PLUGIN/ID", b"y")]))

    def test_package_must_identify_exact_plugin_and_version(self):
        payload = json.dumps({"name":preview.PLUGIN,"version":"old"}).encode()
        with self.assertRaisesRegex(ValueError, "identity or version"):
            preview.validate_identity({"plugin/plugin.json":(None,payload)}, "plugin/plugin.json", preview.PLUGIN)

    @unittest.skipUnless(sys.platform == "win32", "Windows CLI diagnostics")
    def test_status_uses_only_list_methods_and_discloses_desktop_version_change(self):
        rows = [{"pluginId":preview.PLUGIN_ID,"version":"older","enabled":False}]
        with (mock.patch.object(preview,"official_cli",return_value=("fixture-cli","other-package")),
              mock.patch.object(preview,"cli_json",return_value={"installed":rows,"available":[]}) as listed,
              mock.patch.object(preview,"asset_bytes",side_effect=AssertionError("no downloads")),
              mock.patch.object(preview,"install",side_effect=AssertionError("no installation")),
              contextlib.redirect_stdout(io.StringIO()) as output):
            preview.check()
        listed.assert_called_once_with("fixture-cli","list","--marketplace",preview.MARKET,"--available")
        self.assertIn("other-package",output.getvalue())
        self.assertIn("verified desktop package: "+preview.TESTED_DESKTOP,output.getvalue())
        self.assertIn("version=older; enabled=False",output.getvalue())

    def test_installed_or_available_target_does_not_load_unrelated_catalogs(self):
        target = Path.cwd() / "synthetic-market"
        row = {"marketplaceName":preview.MARKET,"marketplaceSource":{"sourceType":"local","source":str(target)}}
        for status in ("installed","available"):
            listing = {"installed":[],"available":[]}
            listing[status].append(row)
            with self.subTest(status=status), mock.patch.object(preview,"cli_json",return_value=listing) as cli:
                self.assertTrue(preview.registered_marketplace("cli",target))
                cli.assert_called_once_with("cli","list","--marketplace",preview.MARKET,"--available")

    def test_foreign_or_unproven_sources_are_preserved(self):
        target = Path.cwd() / "synthetic-market"
        row = {"marketplaceName":preview.MARKET,"marketplaceSource":{"sourceType":"local","source":str(target.parent)}}
        with mock.patch.object(preview,"cli_json",return_value={"installed":[row],"available":[]}):
            with self.assertRaisesRegex(ValueError,"different or unidentified"):
                preview.registered_marketplace("cli",target)
        with mock.patch.object(preview,"cli_json",side_effect=[
                {"installed":[],"available":[]},subprocess.CalledProcessError(1,"list")]):
            with self.assertRaisesRegex(ValueError,"Cannot confirm"):
                preview.registered_marketplace("cli",target)
        with mock.patch.object(preview,"cli_json",side_effect=[
                {"installed":[],"available":[]},{"marketplaces":[]}]):
            self.assertFalse(preview.registered_marketplace("cli",target))


if __name__ == "__main__":
    unittest.main()

import io
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import unittest


class ReleaseValidationTests(unittest.TestCase):
    revision = 'a' * 40

    def extract(self, extras=(), revision=None):
        with tempfile.TemporaryDirectory(prefix='otp-release-test-') as directory:
            root = pathlib.Path(directory)
            archive = root / 'release.tar.gz'
            target = root / 'release'
            target.mkdir()
            with tarfile.open(archive, 'w:gz') as bundle:
                for name, text in {
                    'REVISION': revision or self.revision,
                    'dist/server.js': 'export {};',
                    'package.json': '{}',
                    'node_modules/fastify/package.json': '{}',
                }.items():
                    data = text.encode()
                    member = tarfile.TarInfo(name)
                    member.size = len(data)
                    bundle.addfile(member, io.BytesIO(data))
                for member in extras:
                    bundle.addfile(member, io.BytesIO(b''))
            result = subprocess.run(
                [sys.executable, str(pathlib.Path(__file__).with_name('extract.py')),
                 str(archive), str(target), self.revision], capture_output=True,
            )
            self.assertFalse((root / 'escaped').exists())
            return result.returncode

    def test_valid_release(self):
        self.assertEqual(self.extract(), 0)

    def test_revision_mismatch(self):
        self.assertNotEqual(self.extract(revision='b' * 40), 0)

    def test_path_traversal(self):
        self.assertNotEqual(self.extract([tarfile.TarInfo('../escaped')]), 0)

    def test_unexpected_environment_file(self):
        self.assertNotEqual(self.extract([tarfile.TarInfo('.env')]), 0)

    def test_symlink_escape(self):
        link = tarfile.TarInfo('node_modules/escape')
        link.type = tarfile.SYMTYPE
        link.linkname = '../../escaped'
        self.assertNotEqual(self.extract([link]), 0)

    def test_hardlink_rejected(self):
        link = tarfile.TarInfo('node_modules/hardlink')
        link.type = tarfile.LNKTYPE
        link.linkname = 'package.json'
        self.assertNotEqual(self.extract([link]), 0)

    def test_internal_symlink_allowed(self):
        link = tarfile.TarInfo('node_modules/link')
        link.type = tarfile.SYMTYPE
        link.linkname = 'fastify/package.json'
        self.assertEqual(self.extract([link]), 0)


if __name__ == '__main__':
    unittest.main()

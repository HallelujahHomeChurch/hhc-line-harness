import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('image_release', Path(__file__).with_name('release-image.py'))
image_release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(image_release)

class ImageTest(unittest.TestCase):
    def test_provenance_and_archive_are_both_bound_to_verified_source(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path/'image.tar').write_bytes(b'synthetic image archive')
            digest = hashlib.sha256((path/'image.tar').read_bytes()).hexdigest()
            data = {'source': 'a'*40, 'ref': 'line-harness:'+'a'*40, 'fingerprint': 'b'*64}
            (path/'image.json').write_text(json.dumps(data))
            self.assertEqual(image_release.validate(path, 'a'*40, digest), data)
            with self.assertRaises(ValueError): image_release.validate(path, 'c'*40, digest)
            with self.assertRaises(ValueError): image_release.validate(path, 'a'*40, 'c'*64)
            (path/'extra').write_text('unexpected')
            with self.assertRaises(ValueError): image_release.validate(path, 'a'*40, digest)
            (path/'extra').unlink()
            data['ref'] = 'asset-api:latest'
            (path/'image.json').write_text(json.dumps(data))
            with self.assertRaises(ValueError): image_release.validate(path, 'a'*40, digest)

if __name__ == '__main__': unittest.main()

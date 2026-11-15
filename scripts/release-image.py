"""Transfer the single verified image between CI and the publisher."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

def sha(path):
    with path.open('rb') as stream:
        digest = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
        return digest.hexdigest()

def fingerprint(ref, source):
    image = json.loads(subprocess.check_output(['docker', 'image', 'inspect', ref]))[0]
    if image['Os'] != 'linux' or image['Architecture'] != 'amd64' or image['Config']['Labels'].get('org.opencontainers.image.revision') != source:
        raise ValueError('unexpected image platform or source')
    # Config plus uncompressed layer identities are stable across Docker storage drivers.
    return hashlib.sha256(json.dumps({key: image[key] for key in ['Os', 'Architecture', 'Config', 'RootFS']}, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def validate(directory, source, expected_archive):
    if not re.fullmatch('[0-9a-f]{40}', source) or not re.fullmatch('[0-9a-f]{64}', expected_archive):
        raise ValueError('invalid source or archive digest')
    files = list(directory.iterdir())
    if {p.name for p in files} != {'image.tar', 'image.json'} or any(p.is_symlink() or not p.is_file() for p in files):
        raise ValueError('unexpected artifact files')
    if (directory/'image.json').stat().st_size > 4096 or sha(directory/'image.tar') != expected_archive:
        raise ValueError('artifact integrity mismatch')
    data = json.loads((directory/'image.json').read_text())
    if set(data) != {'source', 'ref', 'fingerprint'} or data['source'] != source or data['ref'] != 'line-harness:'+source or not re.fullmatch('[0-9a-f]{64}', data['fingerprint']):
        raise ValueError('artifact provenance mismatch')
    return data

if __name__ == '__main__':
    try:
        mode, directory, source = sys.argv[1:4]
        directory = Path(directory)
        if not re.fullmatch('[0-9a-f]{40}', source):
            raise ValueError('expected full source SHA')
        ref = 'line-harness:'+source
        if mode == 'pack' and len(sys.argv) == 4:
            directory.mkdir()
            identity = fingerprint(ref, source)
            subprocess.run(['docker', 'save', '--output', str(directory/'image.tar'), ref], check=True)
            (directory/'image.json').write_text(json.dumps({'source': source, 'ref': ref, 'fingerprint': identity}))
            with open(os.environ['GITHUB_OUTPUT'], 'a') as out:
                out.write('archive_sha='+sha(directory/'image.tar')+'\n')
        elif mode == 'load' and len(sys.argv) == 5:
            data = validate(directory, source, sys.argv[4])
            subprocess.run(['docker', 'load', '--input', str(directory/'image.tar')], check=True)
            if fingerprint(ref, source) != data['fingerprint']:
                raise ValueError('loaded image differs from verified image')
        else:
            raise ValueError('usage: pack DIR SHA | load DIR SHA ARCHIVE_SHA')
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
        sys.exit('Image handoff rejected: '+type(error).__name__)

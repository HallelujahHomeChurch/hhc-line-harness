"""Exercise the shell failure mode used by both gated deployment steps."""
from pathlib import Path
import re
import subprocess
import tempfile

workflow = Path('.github/workflows/release-closed.yml').read_text()
ci = Path('.github/workflows/ci.yml').read_text()
for content, prefix in [(ci, 'verified-image-'), (workflow, 'closed-release-receipt-')]:
    artifact_name = re.search(r'name: ('+prefix+r'.*)', content).group(1)
    assert '${{ github.run_attempt }}' in artifact_name, 'rerun must retain a distinct immutable artifact'
for title in ['Deploy and verify bounded migration', 'Deploy and verify private closed API']:
    block = re.search(r'      - name: '+re.escape(title)+r'\n(.*?)(?=\n      - |\Z)', workflow, re.S).group(1)
    args = ['bash', '-e']
    if re.search(r'^        shell: bash$', block, re.M): args += ['-o', 'pipefail']
    with tempfile.TemporaryDirectory() as directory:
        result = subprocess.run([*args, '-c', 'false | tee receipt.json'], cwd=directory, capture_output=True)
        assert result.returncode != 0, title + ' hides the release failure behind tee'
print('Both release steps preserve failure through receipt capture')
